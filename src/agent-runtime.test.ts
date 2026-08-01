// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeSseEvents, parseMcpServers, runAgentTurn } from "./agent-runtime";
import { defaultAgentSettings } from "./settings-defaults";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("agent runtime protocol parsing", () => {
  it("keeps incomplete SSE frames between network chunks", () => {
    const first = consumeSseEvents('data: {"choices":[{"delta":{"content":"一"}}]}\n\ndata: {"partial"');
    expect(first.events).toHaveLength(1);
    expect(first.rest).toBe('data: {"partial"');
    const second = consumeSseEvents(`${first.rest}:true}\r\n\r\n`);
    expect(second.events).toEqual(['{"partial":true}']);
  });

  it("joins multi-line SSE data payloads", () => {
    expect(consumeSseEvents("event: message\ndata: one\ndata: two\n\n").events).toEqual(["one\ntwo"]);
  });

  it("validates Streamable HTTP MCP settings", () => {
    expect(parseMcpServers('[{"name":"docs","url":"https://mcp.example.com","enabled":true}]')[0].name).toBe("docs");
    expect(() => parseMcpServers('[{"name":"missing-url"}]')).toThrow(/url/);
  });

  it("streams text and continues after a model tool call", async () => {
    const encoder = new TextEncoder();
    const sse = (events: string[]) => new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: '{"value":"一叶"}' } }] } }] }),
        "[DONE]",
      ]))
      .mockResolvedValueOnce(sse([
        JSON.stringify({ choices: [{ delta: { content: "完成" } }] }),
        "[DONE]",
      ]));
    globalThis.fetch = fetchMock as typeof fetch;
    const chunks: string[] = [];
    const executed: unknown[] = [];
    const result = await runAgentTurn({
      settings: { ...defaultAgentSettings(), enabled: true },
      systemPrompt: "test",
      messages: [{ role: "user", content: "run", createdAt: 1 }],
      tools: [{
        definition: { type: "function", function: { name: "echo", description: "echo", parameters: { type: "object" } } },
        execute: async (input) => { executed.push(input); return "ok"; },
      }],
      signal: new AbortController().signal,
      onText: (value) => chunks.push(value),
      onTool: () => {},
    });
    expect(executed).toEqual([{ value: "一叶" }]);
    expect(chunks.join("")).toBe("完成");
    expect(result).toEqual({ content: "完成", rounds: 2 });
  });

  it("routes the response after a writer tool into a document text sink", async () => {
    const encoder = new TextEncoder();
    const sse = (events: string[]) => new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "writer-1", function: { name: "begin_document_output", arguments: '{"path":"新文档.md","mode":"create"}' } }] } }] }),
        "[DONE]",
      ]))
      .mockResolvedValueOnce(sse([
        JSON.stringify({ choices: [{ delta: { content: "# 新" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "文档\n\n正文" } }] }),
        "[DONE]",
      ]));
    globalThis.fetch = fetchMock as typeof fetch;
    const chatChunks: string[] = [];
    const documentChunks: string[] = [];
    let completed = 0;
    const result = await runAgentTurn({
      settings: { ...defaultAgentSettings(), enabled: true, maxToolRounds: 1 },
      systemPrompt: "test",
      messages: [{ role: "user", content: "新建文档", createdAt: 1 }],
      tools: [{
        definition: { type: "function", function: { name: "begin_document_output", description: "writer", parameters: { type: "object" } } },
        exclusiveTextSink: true,
        execute: async () => ({
          output: "writer ready",
          textSink: {
            label: "新文档.md",
            onDelta: (delta) => documentChunks.push(delta),
            complete: async () => { completed += 1; return "已保存 新文档.md"; },
            abort: async () => {},
          },
        }),
      }],
      signal: new AbortController().signal,
      onText: (value) => chatChunks.push(value),
      onTool: () => {},
    });

    expect(chatChunks).toEqual([]);
    expect(documentChunks.join("")).toBe("# 新文档\n\n正文");
    expect(completed).toBe(1);
    expect(result).toEqual({ content: "已保存 新文档.md", rounds: 2 });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { tools?: unknown };
    expect(secondRequest.tools).toBeUndefined();
  });

  it("rejects a document writer mixed with another tool before either executes", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: "writer", function: { name: "begin_document_output", arguments: "{}" } },
          { index: 1, id: "other", function: { name: "echo", arguments: "{}" } },
        ] } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const execute = vi.fn(async () => "ok");
    await expect(runAgentTurn({
      settings: { ...defaultAgentSettings(), enabled: true },
      systemPrompt: "test",
      messages: [{ role: "user", content: "write", createdAt: 1 }],
      tools: [
        { definition: { type: "function", function: { name: "begin_document_output", description: "writer", parameters: { type: "object" } } }, exclusiveTextSink: true, execute },
        { definition: { type: "function", function: { name: "echo", description: "echo", parameters: { type: "object" } } }, execute },
      ],
      signal: new AbortController().signal,
      onText: () => {},
      onTool: () => {},
    })).rejects.toThrow(/必须单独调用/);
    expect(execute).not.toHaveBeenCalled();
  });
});
