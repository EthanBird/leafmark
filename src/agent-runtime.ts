import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { PROVIDER_DEFAULTS, providerProfile } from "./agent-providers";
import { api } from "./api";
import type { AgentSettings } from "./types";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  reasoning?: string;
  activities?: AgentToolActivity[];
}

interface RuntimeMessage {
  role: AgentRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
  provider_items?: Array<Record<string, unknown>>;
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
  onPhase?: (message: string) => void;
  onTool: (activity: AgentToolActivity) => void;
}

export interface RunAgentResult {
  content: string;
  rounds: number;
}

export { PROVIDER_DEFAULTS } from "./agent-providers";

export async function runAgentTurn(options: RunAgentOptions): Promise<RunAgentResult> {
  const messages: RuntimeMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...options.messages.map((message) => ({ role: message.role, content: message.content } as RuntimeMessage)),
  ];
  let finalContent = "";
  const maxRounds = Math.max(1, Math.min(16, options.settings.maxToolRounds));

  for (let round = 0; round < maxRounds; round += 1) {
    assertNotAborted(options.signal);
    options.onPhase?.(round === 0 ? "Agent 正在思考…" : "正在分析工具结果并继续思考…");
    const response = await requestCompletion(messages, options, true);
    finalContent += response.content;
    if (!response.toolCalls.length) {
      options.onPhase?.("正在整理最终回答…");
      return { content: finalContent, rounds: round + 1 };
    }

    messages.push({ role: "assistant", content: response.content || null, tool_calls: response.toolCalls, provider_items: response.providerItems });
    options.onPhase?.(`准备执行 ${response.toolCalls.length} 个工具…`);
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
  providerItems?: Array<Record<string, unknown>>;
}

async function requestCompletion(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const protocol = providerProfile(options.settings.provider).protocol;
  if (protocol === "openai-responses") return requestOpenAiResponses(messages, options, emitText);
  if (protocol === "anthropic") return requestAnthropic(messages, options, emitText);
  if (protocol === "gemini-code-assist") return requestGeminiCodeAssist(messages, options, emitText);
  return requestOpenAiChat(messages, options, emitText);
}

async function requestOpenAiChat(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const oauth = options.settings.provider === "copilot" ? await api.getAgentCredential("copilot") : null;
  const endpoint = completionEndpoint(options.settings, oauth?.apiBase || undefined);
  const body: Record<string, unknown> = {
    model: options.settings.model.trim() || PROVIDER_DEFAULTS[options.settings.provider].model,
    messages,
    stream: true,
    temperature: options.settings.temperature,
    top_p: options.settings.topP,
  };
  if (options.settings.provider === "openai-api") body.max_completion_tokens = options.settings.maxTokens;
  else body.max_tokens = options.settings.maxTokens;
  if (options.tools.length) body.tools = options.tools.map((tool) => tool.definition);
  if (options.settings.reasoningEffort !== "none") body.reasoning_effort = options.settings.reasoningEffort;

  const response = await portableFetch(endpoint, {
    method: "POST",
    headers: providerHeaders(options.settings, oauth?.accessToken),
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

async function requestOpenAiResponses(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const credential = await api.getAgentCredential("openai-oauth");
  const profile = providerProfile(options.settings.provider);
  const base = (options.settings.baseUrl.trim() || profile.baseUrl).replace(/\/+$/, "");
  const endpoint = /\/responses$/i.test(base) ? base : `${base}/responses`;
  const input = messages.filter((message) => message.role !== "system").flatMap((message): Record<string, unknown>[] => {
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content || "" }];
    const items: Record<string, unknown>[] = [];
    if (message.content) items.push({ role: message.role, content: message.content });
    items.push(...(message.provider_items ?? []));
    for (const call of message.tool_calls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return items;
  });
  const body: Record<string, unknown> = {
    model: options.settings.model.trim() || profile.model,
    instructions: messages.find((message) => message.role === "system")?.content || "",
    input,
    tools: options.tools.map((tool) => ({
      type: "function",
      name: tool.definition.function.name,
      description: tool.definition.function.description,
      parameters: tool.definition.function.parameters,
      strict: false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (options.settings.reasoningEffort !== "none") body.reasoning = { effort: options.settings.reasoningEffort, summary: "auto" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: "codex_cli_rs",
  };
  if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;
  const response = await portableFetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal });
  if (!response.ok) throw await responseError(response);
  if (!response.body) return parseOpenAiResponsesJson(await response.json() as Record<string, unknown>, options, emitText);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<string, OpenAiToolCall>();
  const providerItems: Array<Record<string, unknown>> = [];
  let buffer = "";
  let content = "";
  while (true) {
    assertNotAborted(options.signal);
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parsed = consumeSseEvents(buffer);
    buffer = parsed.rest;
    for (const data of parsed.events) {
      const event = safeJson(data) as ResponsesStreamEvent | null;
      if (!event) continue;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        content += event.delta;
        if (emitText) options.onText(event.delta);
      }
      if ((event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") && typeof event.delta === "string") {
        options.onReasoning?.(event.delta);
      }
      const item = event.item;
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && item?.type === "function_call") {
        const key = item.id || item.call_id || `call-${calls.size}`;
        calls.set(key, {
          id: item.call_id || key,
          type: "function",
          function: { name: item.name || calls.get(key)?.function.name || "", arguments: item.arguments ?? calls.get(key)?.function.arguments ?? "" },
        });
      }
      if (event.type === "response.output_item.done" && item && (item.type === "reasoning" || item.type === "compaction")) {
        providerItems.push(item as Record<string, unknown>);
      }
      if ((event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") && event.item_id) {
        const call = calls.get(event.item_id);
        if (call) call.function.arguments = event.type.endsWith(".done") && typeof event.arguments === "string" ? event.arguments : call.function.arguments + (event.delta || "");
      }
      if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex Responses 请求失败");
    }
    if (done) break;
  }
  return { content, toolCalls: [...calls.values()].filter((call) => call.function.name), providerItems };
}

function parseOpenAiResponsesJson(json: Record<string, unknown>, options: RunAgentOptions, emitText: boolean): CompletionResult {
  const output = Array.isArray(json.output) ? json.output as Array<Record<string, unknown>> : [];
  let content = "";
  const toolCalls: OpenAiToolCall[] = [];
  const providerItems: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (item.type === "function_call") toolCalls.push({ id: String(item.call_id || item.id || crypto.randomUUID()), type: "function", function: { name: String(item.name || ""), arguments: String(item.arguments || "{}") } });
    if (item.type === "message" && Array.isArray(item.content)) content += item.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
    if (item.type === "reasoning" || item.type === "compaction") providerItems.push(item);
  }
  if (emitText && content) options.onText(content);
  return { content, toolCalls, providerItems };
}

async function requestAnthropic(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const oauth = options.settings.provider === "claude-oauth";
  const credential = oauth ? await api.getAgentCredential("claude-oauth") : null;
  const base = (options.settings.baseUrl.trim() || providerProfile(options.settings.provider).baseUrl).replace(/\/+$/, "");
  const endpoint = /\/messages(?:\?|$)/i.test(base) ? base : `${base}/messages${oauth ? "?beta=true" : ""}`;
  const body: Record<string, unknown> = {
    model: options.settings.model.trim() || providerProfile(options.settings.provider).model,
    system: messages.find((message) => message.role === "system")?.content || "",
    messages: messages.filter((message) => message.role !== "system").map((message) => anthropicMessage(message)),
    max_tokens: options.settings.maxTokens,
    temperature: options.settings.temperature,
    top_p: options.settings.topP,
    stream: true,
  };
  if (options.tools.length) body.tools = options.tools.map((tool) => ({
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    input_schema: tool.definition.function.parameters,
  }));
  if (options.settings.reasoningEffort !== "none") {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: options.settings.reasoningEffort };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream", "anthropic-version": "2023-06-01" };
  if (oauth) {
    headers.Authorization = `Bearer ${credential!.accessToken}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24";
    headers["User-Agent"] = "claude-cli/2.1.123 (external, sdk-cli)";
    headers["x-app"] = "cli";
    headers["X-Claude-Code-Session-Id"] = crypto.randomUUID();
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (options.settings.apiKey.trim()) headers["x-api-key"] = options.settings.apiKey.trim();
  const response = await portableFetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("Anthropic 没有返回流式响应");
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
      const event = safeJson(data) as AnthropicStreamEvent | null;
      if (!event) continue;
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        calls.set(event.index ?? calls.size, { id: event.content_block.id || crypto.randomUUID(), type: "function", function: { name: event.content_block.name || "", arguments: JSON.stringify(event.content_block.input || {}) } });
      }
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          content += event.delta.text;
          if (emitText) options.onText(event.delta.text);
        }
        if (event.delta?.type === "thinking_delta" && event.delta.thinking) options.onReasoning?.(event.delta.thinking);
        if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
          const call = calls.get(event.index ?? -1);
          if (call) call.function.arguments = call.function.arguments === "{}" ? event.delta.partial_json : call.function.arguments + event.delta.partial_json;
        }
      }
      if (event.type === "error") throw new Error(event.error?.message || "Anthropic 请求失败");
    }
    if (done) break;
  }
  return { content, toolCalls: [...calls.values()] };
}

function anthropicMessage(message: RuntimeMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "" }] };
  if (message.role === "assistant" && message.tool_calls?.length) {
    return { role: "assistant", content: [
      ...(message.content ? [{ type: "text", text: message.content }] : []),
      ...message.tool_calls.map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: safeJsonObject(call.function.arguments) })),
    ] };
  }
  return { role: message.role, content: message.content || "" };
}

let geminiProjectId = "";

async function requestGeminiCodeAssist(messages: RuntimeMessage[], options: RunAgentOptions, emitText: boolean): Promise<CompletionResult> {
  const credential = await api.getAgentCredential("gemini-oauth");
  const base = (options.settings.baseUrl.trim() || providerProfile(options.settings.provider).baseUrl).replace(/\/+$/, "");
  if (!geminiProjectId) geminiProjectId = await ensureGeminiProject(base, credential.accessToken, options.signal);
  const priorCalls = new Map<string, string>();
  for (const message of messages) for (const call of message.tool_calls ?? []) priorCalls.set(call.id, call.function.name);
  const contents = messages.filter((message) => message.role !== "system").flatMap((message) => {
    if (message.role === "tool") return [{ role: "user", parts: [{ functionResponse: { name: priorCalls.get(message.tool_call_id || "") || "tool", id: message.tool_call_id, response: { content: message.content || "" } } }] }];
    const parts: Record<string, unknown>[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.tool_calls ?? []) parts.push({ functionCall: { name: call.function.name, id: call.id, args: safeJsonObject(call.function.arguments) } });
    return parts.length ? [{ role: message.role === "assistant" ? "model" : "user", parts }] : [];
  });
  const system = messages.find((message) => message.role === "system")?.content || "";
  const body = {
    model: options.settings.model.trim() || providerProfile(options.settings.provider).model,
    project: geminiProjectId,
    user_prompt_id: crypto.randomUUID(),
    request: {
      contents,
      systemInstruction: system ? { role: "user", parts: [{ text: options.tools.length ? `${system}\n\n## Function calling\nUse native function calls only; never write code that pretends to call a tool.` : system }] } : undefined,
      tools: options.tools.length ? [{ functionDeclarations: options.tools.map((tool) => ({
        name: tool.definition.function.name,
        description: tool.definition.function.description,
        parameters: geminiSchema(tool.definition.function.parameters),
      })) }] : undefined,
      toolConfig: options.tools.length ? { functionCallingConfig: { mode: "AUTO" } } : undefined,
      session_id: crypto.randomUUID(),
    },
  };
  const response = await portableFetch(`${base}/v1internal:generateContent`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    const error = await responseError(response);
    if (/project|not found/i.test(error.message)) geminiProjectId = "";
    throw error;
  }
  const json = await response.json() as GeminiGenerateResponse;
  const parts = json.response?.candidates?.[0]?.content?.parts ?? [];
  let content = "";
  const toolCalls: OpenAiToolCall[] = [];
  for (const part of parts) {
    if (part.text) content += part.text;
    if (part.functionCall?.name) toolCalls.push({
      id: part.functionCall.id || crypto.randomUUID(),
      type: "function",
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
    });
  }
  if (emitText && content) options.onText(content);
  return { content, toolCalls };
}

async function ensureGeminiProject(base: string, accessToken: string, signal: AbortSignal): Promise<string> {
  const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
  const post = async (method: string, body: unknown) => {
    const response = await portableFetch(`${base}/v1internal:${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const loaded = await post("loadCodeAssist", { metadata });
  const existing = stringAt(loaded, "cloudaicompanionProject");
  if (existing) return existing;
  if (loaded.currentTier) throw new Error("Gemini Code Assist 账户没有返回项目；请先在 Gemini CLI 完成一次 Code Assist 初始化");
  const tiers = Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers as Array<Record<string, unknown>> : [];
  const tier = tiers.find((item) => item.isDefault === true) ?? tiers.find((item) => item.id === "free-tier") ?? tiers[0];
  if (!tier) {
    const reason = Array.isArray(loaded.ineligibleTiers) ? (loaded.ineligibleTiers as Array<Record<string, unknown>>).map((item) => item.reasonMessage).filter(Boolean).join("；") : "";
    throw new Error(reason || "此 Google 账户暂时无法使用 Gemini Code Assist");
  }
  let operation = await post("onboardUser", {
    tierId: tier.id,
    metadata: { ...metadata, duetProject: null },
  });
  for (let attempt = 0; operation.done !== true && attempt < 60; attempt += 1) {
    const name = stringAt(operation, "name");
    if (!name) throw new Error("Gemini Code Assist 初始化没有返回操作 ID");
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const response = await portableFetch(`${base}/v1internal/${name.replace(/^\/+/, "")}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
    if (!response.ok) throw await responseError(response);
    operation = await response.json() as Record<string, unknown>;
  }
  const project = nestedString(operation, ["response", "cloudaicompanionProject", "id"]);
  if (!project) throw new Error("Gemini Code Assist 初始化完成，但没有返回项目 ID");
  return project;
}

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const unsupported = new Set(["additionalProperties", "$schema", "$id", "$ref", "$defs", "definitions", "$comment"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !unsupported.has(key)).map(([key, child]) => [key, geminiSchema(child)]));
}

function stringAt(value: Record<string, unknown>, key: string) { return typeof value[key] === "string" ? value[key] as string : ""; }
function nestedString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  return typeof current === "string" ? current : "";
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
    clientInfo: { name: "leafmark", version: "0.5.0" },
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

function completionEndpoint(settings: AgentSettings, overrideBase?: string) {
  const base = (overrideBase?.trim() || settings.baseUrl.trim() || PROVIDER_DEFAULTS[settings.provider].baseUrl).replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function providerHeaders(settings: AgentSettings, oauthToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
  if (oauthToken) headers.Authorization = `Bearer ${oauthToken}`;
  else if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/EthanBird/leafmark";
    headers["X-Title"] = "LeafMark";
  }
  if (settings.provider === "copilot") {
    headers["Copilot-Integration-Id"] = "vscode-chat";
    headers["Editor-Version"] = "vscode/1.95.0";
    headers["Editor-Plugin-Version"] = "copilot-chat/0.22.0";
    headers["Openai-Intent"] = "conversation-panel";
    headers["User-Agent"] = "GitHubCopilotChat/0.22.0";
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

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  arguments?: string;
  item_id?: string;
  item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string; [key: string]: unknown };
  response?: { error?: { message?: string } };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  error?: { message?: string };
}

interface GeminiGenerateResponse {
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }> };
    }>;
  };
}
