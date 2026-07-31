// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyLiveMarkdownShortcut, htmlToMarkdown, matchLiveBlockShortcut } from "./wysiwyg";

describe("live editor serialization", () => {
  it("preserves protected math and Mermaid source blocks", () => {
    const root = document.createElement("article");
    root.innerHTML = `
      <h1>Demo</h1>
      <p>Energy <span class="math-source" data-math-source="E=mc^2"></span></p>
      <figure class="mermaid-block" data-mermaid-source="flowchart LR&#10;A--&gt;B"></figure>
    `;
    const markdown = htmlToMarkdown(root);
    expect(markdown).toContain("# Demo");
    expect(markdown).toContain("$E=mc^2$");
    expect(markdown).toContain("```mermaid\nflowchart LR\nA-->B\n```");
  });

  it("recognizes live heading, quote and list shortcuts as soon as the marker space is typed", () => {
    expect(matchLiveBlockShortcut("# ")).toEqual({ kind: "heading", level: 1, text: "" });
    expect(matchLiveBlockShortcut("### 标题")).toEqual({ kind: "heading", level: 3, text: "标题" });
    expect(matchLiveBlockShortcut("> 引用")).toEqual({ kind: "quote", text: "引用" });
    expect(matchLiveBlockShortcut("- 项目")).toEqual({ kind: "unordered-list", text: "项目" });
    expect(matchLiveBlockShortcut("1. 项目")).toEqual({ kind: "ordered-list", text: "项目" });
  });

  it("turns the active block into a heading without replacing the whole editor", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p># </p><p>正文保持不变</p>";
    document.body.append(root);
    const marker = root.firstElementChild?.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(marker!, marker?.textContent?.length ?? 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(applyLiveMarkdownShortcut(root)).toBe(true);
    expect(root.firstElementChild?.tagName).toBe("H1");
    expect(root.lastElementChild?.textContent).toBe("正文保持不变");
    expect(htmlToMarkdown(root)).toBe("#\n\n正文保持不变\n");
    root.remove();
  });

  it("serializes common rich text structures", () => {
    const root = document.createElement("article");
    root.innerHTML = "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li><li>Two</li></ul>";
    expect(htmlToMarkdown(root)).toBe("## Title\n\n**Bold** and *italic*\n\n- One\n- Two\n");
  });
});
