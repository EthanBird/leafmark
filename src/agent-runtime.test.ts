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
});
