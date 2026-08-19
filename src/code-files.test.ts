// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { documentKindFromPath, highlightLanguageFromPath, renderCodeHtml } from "./code-files";
import { loadTreeExpanded, pruneTreeExpanded, saveTreeExpanded, treeExpandedStorageKey } from "./tree-state";
import { selectionFromTextControl } from "./ask-ai";

describe("code files", () => {
  it("classifies mainstream languages and config files", () => {
    expect(documentKindFromPath("src/App.tsx")).toBe("code");
    expect(documentKindFromPath("main.py")).toBe("code");
    expect(documentKindFromPath("Dockerfile")).toBe("code");
    expect(documentKindFromPath(".gitignore")).toBe("code");
    expect(documentKindFromPath(".env")).toBe("code");
    expect(documentKindFromPath(".editorconfig")).toBe("code");
    expect(highlightLanguageFromPath(".gitignore")).toBe("ini");
    expect(documentKindFromPath("notes.md")).toBe("markdown");
    expect(documentKindFromPath("deck.pptx")).toBe("presentation");
    expect(documentKindFromPath("virus.exe")).toBeNull();
    expect(highlightLanguageFromPath("App.tsx")).toBe("typescript");
    expect(highlightLanguageFromPath("Makefile")).toBe("makefile");
  });

  it("renders a fenced code document without interpreting markdown", () => {
    const html = renderCodeHtml("const n = 1 < 2;\n```\ntrap", "typescript");
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain("const n = 1");
    expect(html).toContain("&lt;");
    expect(html).not.toContain("<script");
  });
});

describe("文档库展开记忆", () => {
  const workspace = "/tmp/leafmark-notes";

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to collapsed and remembers expanded folders per workspace", () => {
    expect(loadTreeExpanded(workspace)).toEqual([]);
    saveTreeExpanded(workspace, ["课程", "课程/第一章"]);
    expect(loadTreeExpanded(workspace)).toEqual(["课程", "课程/第一章"]);
    expect(localStorage.getItem(treeExpandedStorageKey("/other"))).toBeNull();
    const pruned = pruneTreeExpanded(["课程", "已删除"], [
      { path: "课程", name: "课程", kind: "directory", depth: 0, size: 0, modifiedMs: 0, documentKind: "directory" },
      { path: "欢迎.md", name: "欢迎.md", kind: "file", depth: 0, size: 1, modifiedMs: 0, documentKind: "markdown" },
    ]);
    expect([...pruned]).toEqual(["课程"]);
  });
});

describe("划词问 AI 源码选区", () => {
  it("reads the selected range from a textarea inside the document host", () => {
    const host = document.createElement("div");
    host.className = "document-host";
    const textarea = document.createElement("textarea");
    textarea.value = "hello LeafMark world";
    host.append(textarea);
    document.body.append(host);
    textarea.focus();
    textarea.setSelectionRange(6, 14);
    expect(selectionFromTextControl(host)?.text).toBe("LeafMark");
    host.remove();
  });
});
