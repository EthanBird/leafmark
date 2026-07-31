import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import type { AgentSettings } from "./types";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

interface RuntimeMessage {
  role: AgentRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentRuntimeTool {
  definition: AgentToolDefinition;
  execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

export interface AgentToolActivity {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "done" | "error";
  output?: string;
}

export interface RunAgentOptions {
  settings: AgentSettings;
  systemPrompt: string;
  messages: AgentConversationMessage[];
  tools: AgentRuntimeTool[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onTool: (activity: AgentToolActivity) => void;
}

export interface RunAgentResult {
  content: string;
  rounds: number;
}

export const PROVIDER_DEFAULTS: Record<AgentSettings["provider"], { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-5.4-mini" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
  custom: { baseUrl: "https://example.com/v1", model: "model-id" },
};

export async function runAgentTurn(options: RunAgentOptions): Promise<RunAgentResult> {
  const messages: RuntimeMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...options.messages.map((message) => ({ role: message.role, content: message.content } as RuntimeMessage)),
  ];
  let finalContent = "";
  const maxRounds = Math.max(1, Math.min(16, options.settings.maxToolRounds));

  for (let round = 0; round < maxRounds; round += 1) {
    assertNotAborted(options.signal);
    const response = await requestCompletion(messages, options, true);
    finalContent += response.content;
    if (!response.toolCalls.length) return { content: finalContent, rounds: round + 1 };

    messages.push({ role: "assistant", content: response.content || null, tool_calls: response.toolCalls });
    for (const call of response.toolCalls) {
      const tool = options.tools.find((candidate) => candidate.definition.function.name === call.function.name);
      const input = safeJsonObject(call.function.arguments);
      const activity: AgentToolActivity = { id: call.id, name: call.function.name, input, status: "running" };
      options.onTool(activity);
      let output: string;
      try {
        output = tool
          ? await tool.execute(input, options.signal)
          : `未知工具：${call.function.name}`;
        options.onTool({ ...activity, status: tool ? "done" : "error", output });
      } catch (error) {
        output = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
        options.onTool({ ...activity, status: "error", output });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: truncateToolOutput(output) });
    }
  }
  throw new Error(`Agent 连续执行了 ${maxRounds} 轮工具仍未结束，请缩小任务范围或提高最大工具轮数`);
}

interface CompletionResult {
  content: string;
  toolCalls: OpenAiToolCall[];
}

async function requestCompletion(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const endpoint = completionEndpoint(options.settings);
  const body: Record<string, unknown> = {
    model: options.settings.model.trim() || PROVIDER_DEFAULTS[options.settings.provider].model,
    messages,
    stream: true,
    temperature: options.settings.temperature,
    top_p: options.settings.topP,
  };
  if (options.settings.provider === "openai") body.max_completion_tokens = options.settings.maxTokens;
  else body.max_tokens = options.settings.maxTokens;
  if (options.tools.length) body.tools = options.tools.map((tool) => tool.definition);
  if (options.settings.reasoningEffort !== "none") body.reasoning_effort = options.settings.reasoningEffort;

  const response = await portableFetch(endpoint, {
    method: "POST",
    headers: providerHeaders(options.settings),
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) throw await responseError(response);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const json = await response.json() as OpenAiResponse;
    const message = json.choices?.[0]?.message;
    const content = stringContent(message?.content);
    if (emitText && content) options.onText(content);
    return { content, toolCalls: normalizeToolCalls(message?.tool_calls) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, OpenAiToolCall>();
  let buffer = "";
  let content = "";
  while (true) {
    assertNotAborted(options.signal);
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parsed = consumeSseEvents(buffer);
    buffer = parsed.rest;
    for (const data of parsed.events) {
      if (data === "[DONE]") continue;
      const chunk = safeJson(data) as OpenAiStreamChunk | null;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;
      const text = stringContent(delta.content);
      if (text) {
        content += text;
        if (emitText) options.onText(text);
      }
      const reasoning = stringContent(delta.reasoning_content);
      if (reasoning) options.onReasoning?.(reasoning);
      for (const fragment of delta.tool_calls ?? []) mergeToolCall(calls, fragment);
    }
    if (done) break;
  }
  return { content, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) };
}

export function consumeSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [data] : [];
  });
  return { events, rest };
}

function mergeToolCall(calls: Map<number, OpenAiToolCall>, fragment: Partial<OpenAiToolCall> & { index?: number; function?: { name?: string; arguments?: string } }) {
  const index = fragment.index ?? calls.size;
  const current = calls.get(index) ?? {
    id: fragment.id ?? `tool-${index}`,
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  if (fragment.id) current.id = fragment.id;
  if (fragment.function?.name) current.function.name += fragment.function.name;
  if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
  calls.set(index, current);
}

export interface McpServerConfig {
  name: string;
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}

export async function loadMcpTools(json: string, signal: AbortSignal): Promise<AgentRuntimeTool[]> {
  const configs = parseMcpServers(json);
  const groups = await Promise.all(configs.filter((config) => config.enabled !== false).map(async (config) => {
    try {
      return await connectMcpServer(config, signal);
    } catch (error) {
      return [errorTool(config.name, error)];
    }
  }));
  return groups.flat();
}

export function parseMcpServers(json: string): McpServerConfig[] {
  if (!json.trim()) return [];
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value)) throw new Error("MCP 配置必须是 JSON 数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 个 MCP 配置无效`);
    const config = item as Partial<McpServerConfig>;
    if (!config.name?.trim() || !config.url?.trim()) throw new Error(`第 ${index + 1} 个 MCP 配置缺少 name 或 url`);
    return { name: config.name.trim(), url: config.url.trim(), enabled: config.enabled !== false, headers: config.headers ?? {} };
  });
}

async function connectMcpServer(config: McpServerConfig, signal: AbortSignal): Promise<AgentRuntimeTool[]> {
  let sessionId = "";
  const rpc = async (method: string, params?: unknown, notification = false) => {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
      ...config.headers,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const response = await portableFetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: crypto.randomUUID() }), method, ...(params === undefined ? {} : { params }) }),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    sessionId ||= response.headers.get("mcp-session-id") ?? "";
    if (notification || response.status === 202) return null;
    return parseMcpResponse(await response.text());
  };
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "leafmark", version: "0.4.6" },
  });
  await rpc("notifications/initialized", undefined, true);
  const listed = await rpc("tools/list", {}) as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }; error?: { message?: string } } | null;
  if (listed?.error) throw new Error(listed.error.message || "MCP tools/list 失败");
  return (listed?.result?.tools ?? []).map((tool) => {
    const name = `mcp__${safeToolName(config.name)}__${safeToolName(tool.name)}`;
    return {
      definition: {
        type: "function",
        function: {
          name,
          description: `[MCP: ${config.name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      },
      execute: async (input: Record<string, unknown>) => {
        const result = await rpc("tools/call", { name: tool.name, arguments: input }) as { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } } | null;
        if (result?.error) throw new Error(result.error.message || `MCP 工具 ${tool.name} 失败`);
        const text = result?.result?.content?.map((part) => part.text ?? JSON.stringify(part)).join("\n") ?? "工具执行完成";
        if (result?.result?.isError) throw new Error(text);
        return text;
      },
    } satisfies AgentRuntimeTool;
  });
}

function errorTool(server: string, error: unknown): AgentRuntimeTool {
  const message = error instanceof Error ? error.message : String(error);
  return {
    definition: {
      type: "function",
      function: {
        name: `mcp__${safeToolName(server)}__connection_error`,
        description: `报告 MCP 服务器 ${server} 的连接错误。仅在用户询问 MCP 状态时调用。`,
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async () => `MCP 服务器 ${server} 连接失败：${message}`,
  };
}

export async function fetchWebText(url: string, signal: AbortSignal): Promise<string> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("只支持 HTTP/HTTPS 地址");
  const response = await portableFetch(parsed.toString(), { signal, headers: { Accept: "text/plain,text/html,application/json" } });
  if (!response.ok) throw await responseError(response);
  const text = await response.text();
  return text.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40_000);
}

function completionEndpoint(settings: AgentSettings) {
  const base = (settings.baseUrl.trim() || PROVIDER_DEFAULTS[settings.provider].baseUrl).replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function providerHeaders(settings: AgentSettings): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/EthanBird/leafmark";
    headers["X-Title"] = "LeafMark";
  }
  return headers;
}

function portableFetch(input: string, init?: RequestInit): Promise<Response> {
  return "__TAURI_INTERNALS__" in window
    ? nativeFetch(input, init) as Promise<Response>
    : globalThis.fetch(input, init);
}

async function responseError(response: Response) {
  const detail = (await response.text()).slice(0, 1200);
  return new Error(`模型服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
}

function parseMcpResponse(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const parsed = consumeSseEvents(`${trimmed}\n\n`);
  const data = parsed.events.at(-1);
  if (!data) throw new Error("MCP 服务器没有返回 JSON-RPC 数据");
  return JSON.parse(data);
}

function normalizeToolCalls(value: unknown): OpenAiToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OpenAiToolCall => Boolean(item && typeof item === "object" && (item as OpenAiToolCall).function?.name));
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("");
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function safeJsonObject(value: string): Record<string, unknown> {
  const parsed = safeJson(value || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function safeToolName(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

function truncateToolOutput(output: string) {
  return output.length <= 40_000 ? output : `${output.slice(0, 39_500)}\n\n[工具输出已截断]`;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Agent 已停止", "AbortError");
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
}

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: Array<Partial<OpenAiToolCall> & { index?: number; function?: { name?: string; arguments?: string } }> } }>;
}
