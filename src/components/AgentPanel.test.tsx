// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentSettings } from "../settings-defaults";
import { AgentPanel, type AgentDocumentHost } from "./AgentPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host: AgentDocumentHost = {
  current: { path: "测试.md", content: "# 测试", origin: "workspace", archiveId: "archive-test" },
  documents: [],
  readDocument: async () => "# 测试",
  replaceCurrentDocument: async () => {},
  replaceText: async () => "ok",
  createDocument: async () => "ok",
  openDocument: async () => {},
  searchDocuments: async () => [],
  flushDocumentChanges: async () => {},
  reconcileExternalChanges: async () => {},
  beginVersionTurn: async () => {},
  finishVersionTurn: async (turnId, outcome) => ({
    id: `version-${turnId}`,
    sessionId: "session-test",
    turnId,
    label: "测试",
    createdMs: Date.now(),
    outcome,
    changes: [],
  }),
  versionStatus: async () => ({ undo: null, redo: null, pending: false }),
  undoVersion: async () => { throw new Error("no undo"); },
  redoVersion: async () => { throw new Error("no redo"); },
};

let cleanup = () => {};
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("AgentPanel", () => {
  it("renders saved and streaming-style assistant Markdown and exposes the full OpenAI effort ladder", async () => {
    localStorage.setItem("leafmark.agent.sessions.v1", JSON.stringify([{
      id: "session-1",
      title: "Markdown",
      createdAt: 1,
      updatedAt: 1,
      messages: [{ role: "assistant", content: "# 标题\n\n**实时加粗**", createdAt: 1 }],
    }]));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      cleanup = () => {};
    };

    await act(async () => {
      root.render(<AgentPanel
        settings={{ ...defaultAgentSettings(), provider: "openai-oauth", reasoningEffort: "low" }}
        host={host}
        onOpenSettings={() => {}}
        onReasoningEffortChange={() => {}}
      />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(container.querySelector(".agent-markdown h1")?.textContent).toBe("标题");
    expect(container.querySelector(".agent-markdown strong")?.textContent).toBe("实时加粗");
    const efforts = [...container.querySelectorAll<HTMLSelectElement>(".agent-context select option")].map((option) => option.value);
    expect(efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });
});
