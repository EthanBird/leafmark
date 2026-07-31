// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyLiveInlineMarkdownShortcut,
  applyLiveMarkdownShortcut,
  htmlToMarkdown,
  matchLiveBlockShortcut,
  matchLiveInlineShortcut,
} from "./wysiwyg";

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

  it("recognizes complete inline Markdown around the caret", () => {
    expect(matchLiveInlineShortcut("这里是 **粗体**", 10)?.kind).toBe("bold");
    expect(matchLiveInlineShortcut("这里是 *斜体*", 8)?.kind).toBe("italic");
    expect(matchLiveInlineShortcut("这里是 ~~删除~~", 10)?.kind).toBe("strike");
    expect(matchLiveInlineShortcut("这里是 `代码`", 8)?.kind).toBe("code");
    expect(matchLiveInlineShortcut("访问 [LeafMark](https://example.com)", 34)).toMatchObject({
      kind: "link",
      text: "LeafMark",
      href: "https://example.com",
    });
    expect(matchLiveInlineShortcut("尚未闭合 **粗体", 9)).toBeNull();
    expect(matchLiveInlineShortcut("转义 \\**原样**", 10)).toBeNull();
  });

  it("renders typed bold markers in place and preserves Markdown on save", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>这是 **立即加粗**</p><p>下一段不变</p>";
    document.body.append(root);
    const text = root.querySelector("p")?.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text!, text?.textContent?.length ?? 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(applyLiveInlineMarkdownShortcut(root)).toBe(true);
    expect(root.querySelector("strong")?.textContent).toBe("立即加粗");
    expect(root.textContent).not.toContain("**");
    expect(htmlToMarkdown(root)).toBe("这是 **立即加粗**\n\n下一段不变\n");
    expect(selection?.anchorNode).toBe(root.firstElementChild);
    expect(selection?.anchorOffset).toBe(2);
    root.remove();
  });

  it.each([
    ["*斜体*", "em", "*斜体*"],
    ["~~删除~~", "del", "~~删除~~"],
    ["`代码`", "code", "`代码`"],
    ["[链接](notes.md)", "a", "[链接](notes.md)"],
  ])("renders %s without rebuilding the editor", (source, tag, markdown) => {
    const root = document.createElement("article");
    root.innerHTML = `<p>${source}</p>`;
    document.body.append(root);
    const text = root.firstElementChild?.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text!, text?.textContent?.length ?? 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(applyLiveInlineMarkdownShortcut(root)).toBe(true);
    expect(root.querySelector(tag)?.textContent).toBe(tag === "a" ? "链接" : source.replaceAll(/[*~`]/g, ""));
    expect(htmlToMarkdown(root)).toBe(`${markdown}\n`);
    root.remove();
  });

  it("serializes common rich text structures", () => {
    const root = document.createElement("article");
    root.innerHTML = "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li><li>Two</li></ul>";
    expect(htmlToMarkdown(root)).toBe("## Title\n\n**Bold** and *italic*\n\n- One\n- Two\n");
  });
});
