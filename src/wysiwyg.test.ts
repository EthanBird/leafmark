// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./wysiwyg";

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

  it("serializes common rich text structures", () => {
    const root = document.createElement("article");
    root.innerHTML = "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li><li>Two</li></ul>";
    expect(htmlToMarkdown(root)).toBe("## Title\n\n**Bold** and *italic*\n\n- One\n- Two\n");
  });
});
