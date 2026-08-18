// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings } from "../settings-defaults";
import { AgentPanel, buildAgentTools, buildSystemPrompt, type AgentDocumentHost } from "./AgentPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host: AgentDocumentHost = {
  current: { path: "测试.md", content: "# 测试", origin: "workspace", archiveId: "archive-test" },
  office: null,
  documents: [],
  readDocument: async () => "# 测试",
  replaceCurrentDocument: async () => {},
  replaceText: async () => "ok",
  createDocument: async () => "ok",
  moveDocument: async (path, destinationFolder) => `${destinationFolder}/${path}`,
  beginDocumentStream: async (_path, mode) => ({ id: "stream-test", path: "流式.md", mode }),
  appendDocumentStream: () => {},
  finishDocumentStream: async () => ({ id: "stream-test", path: "流式.md", mode: "create", characters: 0, bytes: 0 }),
  abortDocumentStream: async () => {},
  openDocument: async () => {},
  searchDocuments: async () => [],
  inspectOffice: async () => { throw new Error("当前没有打开 Word / Excel / PPT"); },
  readOffice: async () => { throw new Error("当前没有打开 Word / Excel / PPT"); },
  executeOffice: async () => { throw new Error("当前没有打开 Word / Excel / PPT"); },
  undoOffice: async () => { throw new Error("当前没有打开 Word / Excel / PPT"); },
  redoOffice: async () => { throw new Error("当前没有打开 Word / Excel / PPT"); },
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
  findVersionForTurn: async () => null,
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
  it("offers a guarded document-library move tool with a destination folder", async () => {
    const moveDocument = vi.fn(async (path: string, destinationFolder: string) => `${destinationFolder}/note.md`);
    const tools = buildAgentTools(
      { ...defaultAgentSettings(), allowDocumentEdits: true },
      { ...host, moveDocument },
      { id: "session-move", title: "移动", createdAt: 1, updatedAt: 1, messages: [], cursor: 0 },
      () => {},
    );
    const move = tools.find((item) => item.definition.function.name === "move_document");

    expect(move?.definition.function.parameters).toMatchObject({
      required: ["path", "destination_folder"],
      additionalProperties: false,
    });
    await expect(move?.execute({ path: "待整理/note.md", destination_folder: "归档/2026" }, new AbortController().signal))
      .resolves.toBe("已移动 待整理/note.md → 归档/2026/note.md");
    expect(moveDocument).toHaveBeenCalledWith("待整理/note.md", "归档/2026");
  });

  it("does not allow the move tool to bypass disabled document edits", async () => {
    const moveDocument = vi.fn(async () => "归档/note.md");
    const tools = buildAgentTools(
      { ...defaultAgentSettings(), allowDocumentEdits: false },
      { ...host, moveDocument },
      { id: "session-readonly", title: "只读", createdAt: 1, updatedAt: 1, messages: [], cursor: 0 },
      () => {},
    );
    const move = tools.find((item) => item.definition.function.name === "move_document");

    await expect(move?.execute({ path: "note.md", destination_folder: "归档" }, new AbortController().signal))
      .rejects.toThrow("尚未允许 Agent 修改文档");
    expect(moveDocument).not.toHaveBeenCalled();
  });

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
        onActivityChange={() => {}}
      />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(container.querySelector(".agent-markdown h1")?.textContent).toBe("标题");
    expect(container.querySelector(".agent-markdown strong")?.textContent).toBe("实时加粗");
    const efforts = [...container.querySelectorAll<HTMLSelectElement>(".agent-context select option")].map((option) => option.value);
    expect(efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("keeps tool details in an accessible disclosure without disturbing adjacent cards", async () => {
    const longValue = `https://example.com/${"unbroken".repeat(80)}`;
    localStorage.setItem("leafmark.agent.sessions.v1", JSON.stringify([{
      id: "session-tools",
      title: "工具卡片",
      createdAt: 1,
      updatedAt: 1,
      cursor: 1,
      messages: [{
        role: "assistant",
        content: "工具执行结果",
        createdAt: 1,
        activities: [{
          id: "tool-one",
          name: "web_fetch_with_a_very_long_provider_tool_name",
          status: "done",
          input: { url: longValue },
          output: longValue,
        }, {
          id: "tool-two",
          name: "read_document",
          status: "done",
          input: { path: "第二份文档.md" },
          output: "完成",
        }],
      }],
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
        settings={defaultAgentSettings()}
        host={host}
        onOpenSettings={() => {}}
        onReasoningEffortChange={() => {}}
        onActivityChange={() => {}}
      />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const cards = [...container.querySelectorAll<HTMLElement>(".agent-tool")];
    const firstToggle = cards[0].querySelector<HTMLButtonElement>(".agent-tool-summary")!;
    const firstContent = cards[0].querySelector<HTMLElement>(".agent-tool-content")!;
    const secondToggle = cards[1].querySelector<HTMLButtonElement>(".agent-tool-summary")!;
    expect(cards).toHaveLength(2);
    expect(firstToggle.getAttribute("aria-controls")).toBe(firstContent.id);
    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(firstContent.hidden).toBe(true);

    await act(async () => {
      firstToggle.querySelector("strong")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
    expect(firstContent.hidden).toBe(false);
    expect(firstContent.textContent).toContain(longValue);
    expect(secondToggle.getAttribute("aria-expanded")).toBe("false");
    expect(cards[1].querySelector<HTMLElement>(".agent-tool-content")!.hidden).toBe(true);
  });

  it("exposes copy and save-as-markdown actions on assistant replies", async () => {
    const createDocument = vi.fn(async (path: string, content: string) => `已创建并打开 ${path}: ${content.length}`);
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    localStorage.setItem("leafmark.agent.sessions.v1", JSON.stringify([{
      id: "session-copy",
      title: "复制",
      createdAt: 1,
      updatedAt: 1,
      messages: [{ role: "assistant", content: "# 结论\n\n可以保存。", createdAt: 1 }],
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
        settings={defaultAgentSettings()}
        host={{ ...host, createDocument }}
        onOpenSettings={() => {}}
        onReasoningEffortChange={() => {}}
        onActivityChange={() => {}}
      />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".agent-message-actions button")];
    expect(buttons.map((button) => button.textContent?.replace(/\s+/g, ""))).toEqual(["复制", "保存为Markdown"]);

    await act(async () => {
      buttons[0].click();
      buttons[1].click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(writeText).toHaveBeenCalledWith("# 结论\n\n可以保存。");
    expect(createDocument).toHaveBeenCalled();
    expect(String(createDocument.mock.calls[0][0])).toMatch(/^agent-replies\/.+\.md$/);
    expect(createDocument.mock.calls[0][1]).toBe("# 结论\n\n可以保存。");
  });

  it("guards office write tools until document edits are allowed", async () => {
    const executeOffice = vi.fn(async () => "ok");
    const inspectOffice = vi.fn(async () => "{\"kind\":\"word\"}");
    const tools = buildAgentTools(
      { ...defaultAgentSettings(), allowDocumentEdits: false },
      { ...host, office: { key: "doc-1", kind: "word", path: "说明.docx", format: "docx" }, executeOffice, inspectOffice },
      { id: "session-office", title: "办公", createdAt: 1, updatedAt: 1, messages: [], cursor: 0 },
      () => {},
    );
    const execute = tools.find((item) => item.definition.function.name === "office_execute");
    const inspect = tools.find((item) => item.definition.function.name === "inspect_office");
    await expect(inspect?.execute({}, new AbortController().signal)).resolves.toBe("{\"kind\":\"word\"}");
    await expect(execute?.execute({ mutation: { op: "wordFindReplace", query: "a", replacement: "b" } }, new AbortController().signal))
      .rejects.toThrow("尚未允许 Agent 修改文档");
    expect(executeOffice).not.toHaveBeenCalled();
  });

  it("injects WPS skills and office context into the system prompt", () => {
    const prompt = buildSystemPrompt(
      { ...defaultAgentSettings(), enabledSkills: ["wps-excel"] },
      null,
      { key: "xlsx-1", kind: "spreadsheet", path: "表.xlsx", format: "xlsx" },
      "汇总这一列",
    );
    expect(prompt).toContain("wps-excel");
    expect(prompt).toContain("sheetEdit");
    expect(prompt).toContain("表.xlsx");
    expect(prompt).toContain("inspect_office");
    expect(prompt).not.toContain("wps_office_search");
  });
});
