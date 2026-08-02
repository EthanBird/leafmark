// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { initializeMermaid, renderMermaid } = vi.hoisted(() => ({
  initializeMermaid: vi.fn(),
  renderMermaid: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

import {
  createPdfMermaidContent,
  extractMermaidSources,
  inlineMermaidSvgStyles,
  normalizeMermaidSource,
  normalizeMermaidSvg,
  preparePdfMermaidDiagrams,
  renderMermaidSvgQueued,
  resolvePdfMermaidDiagram,
  withMermaidRenderLock,
} from "./pdf-mermaid";

const diagramSvg = (width = 400, height = 200) => (
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${width} ${height}"><text>一叶</text></svg>`
);

describe("PDF Mermaid preparation", () => {
  beforeEach(() => {
    initializeMermaid.mockReset();
    renderMermaid.mockReset();
  });

  it("extracts nested Mermaid fences, normalizes line endings, and deduplicates sources", () => {
    const markdown = [
      "```mermaid",
      "flowchart LR",
      "A-->B",
      "```",
      "",
      "> ```MERMAID",
      "> flowchart LR",
      "> A-->B",
      "> ```",
      "",
      "- diagram",
      "",
      "  ```mermaid title=secondary",
      "  sequenceDiagram",
      "  A->>B: hello",
      "  ```",
      "",
      "```typescript",
      "const mermaid = false;",
      "```",
    ].join("\n");

    expect(extractMermaidSources(markdown)).toEqual([
      "flowchart LR\nA-->B",
      "sequenceDiagram\nA->>B: hello",
    ]);
    expect(normalizeMermaidSource("\r\nflowchart LR\r\nA-->B\r\n")).toBe("flowchart LR\nA-->B");
  });

  it("normalizes SVG dimensions to bounded PDF points", () => {
    const diagram = normalizeMermaidSvg(
      "flowchart LR\nA-->B",
      diagramSvg(1_000, 2_000),
      { maxWidth: 487, maxHeight: 620 },
    );

    expect(diagram).not.toBeNull();
    expect(diagram?.width).toBe(310);
    expect(diagram?.height).toBe(620);
    expect(diagram?.svg).toContain('width="310" height="620"');
    expect(diagram?.svg).not.toContain('width="100%"');
    expect(normalizeMermaidSvg("A-->B", "<div>not svg</div>")).toBeNull();
    expect(normalizeMermaidSvg("A-->B", "<svg viewBox=\"0 0 0 10\"></svg>")).toBeNull();
    expect(normalizeMermaidSvg("A-->B", '<svg viewBox="0 0 10 10"><foreignObject /></svg>')).toBeNull();
  });

  it("inlines Mermaid CSS presentation styles for pdfmake", () => {
    const svg = inlineMermaidSvgStyles([
      '<svg id="diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">',
      "<style>#diagram .node{fill:#e8f3ec;stroke:#297a4a;stroke-width:2px}#diagram text{fill:#1d2922;font-family:LeafMark;font-weight:700}</style>",
      '<rect class="node" x="1" y="1" width="98" height="38"/>',
      '<text x="10" y="24">LeafMark</text>',
      "</svg>",
    ].join(""), "LeafMark");

    expect(svg).not.toContain("<style");
    expect(svg).toMatch(/<rect[^>]*fill="(?:#e8f3ec|rgb\(232, 243, 236\))"/);
    expect(svg).toMatch(/<rect[^>]*stroke="(?:#297a4a|rgb\(41, 122, 74\))"/);
    expect(svg).toMatch(/<text[^>]*font-family="LeafMark"/);
    expect(svg).toMatch(/<text[^>]*font-weight="(?:700|bold)"/);
  });

  it("converts unavoidable HTML labels to portable SVG text", () => {
    const svg = inlineMermaidSvgStyles([
      '<svg id="diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">',
      "<style>#diagram .label text{fill:#1d2922;font-family:LeafMark}</style>",
      "<switch>",
      '<foreignObject x="50" y="20" width="200" height="60">',
      '<div class="task"><div class="label">第一行<br/>A &amp; B</div></div>',
      '</foreignObject><text x="150" y="50">fallback</text></switch></svg>',
    ].join(""));

    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toContain("<switch");
    expect(svg).not.toContain("fallback");
    expect(svg).toContain('class="label foreign-object-label task"');
    expect(svg).toContain('x="150"');
    expect(svg).toContain("第一行");
    expect(svg).toContain("A &amp; B");
    expect(svg.match(/<tspan/g)).toHaveLength(2);
  });

  it("removes zero-length dash arrays rejected by svg-to-pdfkit", () => {
    const svg = inlineMermaidSvgStyles([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">',
      '<path class="solid" style="stroke:#333;stroke-dasharray:1,0" d="M0 0L10 10"/>',
      '<path class="dashed" style="stroke:#333;stroke-dasharray:3,2" d="M0 10L10 20"/>',
      "</svg>",
    ].join(""));

    expect(svg.match(/class="solid"[^>]*>/)?.[0]).not.toContain("stroke-dasharray");
    expect(svg.match(/class="dashed"[^>]*>/)?.[0]).toContain('stroke-dasharray="3,2"');
  });

  it("configures PDF-safe SVG labels and the embedded LeafMark font", async () => {
    renderMermaid.mockResolvedValue({ svg: diagramSvg() });

    await renderMermaidSvgQueued("flowchart LR\nA-->B", {
      theme: "base",
      themeVariables: { primaryColor: "#e8f3ec" },
      fontFamily: "LeafMark",
      htmlLabels: false,
    });

    expect(initializeMermaid).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict",
      theme: "base",
      themeVariables: { primaryColor: "#e8f3ec" },
      fontFamily: "LeafMark",
      htmlLabels: false,
      flowchart: expect.objectContaining({ htmlLabels: false }),
    }));
    expect(renderMermaid).toHaveBeenCalledWith(expect.stringMatching(/^leafmark-pdf-diagram-/), "flowchart LR\nA-->B");
  });

  it("resolves diagrams across harmless source whitespace differences", () => {
    const diagram = normalizeMermaidSvg("flowchart LR\nA-->B", diagramSvg());
    expect(diagram).not.toBeNull();
    expect(resolvePdfMermaidDiagram([diagram!], "\r\nflowchart LR\r\nA-->B\r\n")).toBe(diagram);
    expect(resolvePdfMermaidDiagram([diagram!], "flowchart LR\nA-->C")).toBeUndefined();
    expect(createPdfMermaidContent("MERMAID title=diagram", "flowchart LR\nA-->B", [diagram!])).toMatchObject({
      svg: diagram?.svg,
      width: diagram?.width,
      height: diagram?.height,
      alignment: "center",
      unbreakable: true,
    });
    expect(createPdfMermaidContent("typescript", "flowchart LR\nA-->B", [diagram!])).toBeNull();
  });

  it("renders sequentially and skips an invalid diagram without rejecting the export", async () => {
    let active = 0;
    let maximumActive = 0;
    const failures: string[] = [];
    const markdown = [
      "```mermaid\nflowchart LR\nA-->B\n```",
      "```mermaid\nbroken diagram\n```",
      "```mermaid\nsequenceDiagram\nA->>B: hi\n```",
    ].join("\n\n");

    const diagrams = await preparePdfMermaidDiagrams(markdown, {
      renderer: async (source) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        if (source === "broken diagram") throw new Error("invalid syntax");
        return diagramSvg();
      },
      onError: (source) => failures.push(source),
    });

    expect(maximumActive).toBe(1);
    expect(diagrams.map((diagram) => diagram.source)).toEqual([
      "flowchart LR\nA-->B",
      "sequenceDiagram\nA->>B: hi",
    ]);
    expect(failures).toEqual(["broken diagram"]);
  });

  it("serializes Mermaid configuration and rendering operations across callers", async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const run = (name: string) => withMermaidRenderLock(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`${name}:end`);
      active -= 1;
    });

    await Promise.all([run("first"), run("second")]);

    expect(maximumActive).toBe(1);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("stops before starting another diagram after cancellation", async () => {
    const controller = new AbortController();
    const rendered: string[] = [];
    const markdown = [
      "```mermaid\nflowchart LR\nA-->B\n```",
      "```mermaid\nflowchart LR\nB-->C\n```",
    ].join("\n\n");

    const diagrams = await preparePdfMermaidDiagrams(markdown, {
      signal: controller.signal,
      renderer: async (source) => {
        rendered.push(source);
        controller.abort();
        return diagramSvg();
      },
    });

    expect(rendered).toEqual(["flowchart LR\nA-->B"]);
    expect(diagrams).toEqual([]);
  });

  it("yields to the UI so cancellation can stop the next diagram", async () => {
    const controller = new AbortController();
    const rendered: string[] = [];
    const markdown = [
      "```mermaid\nflowchart LR\nA-->B\n```",
      "```mermaid\nflowchart LR\nB-->C\n```",
    ].join("\n\n");

    const diagrams = await preparePdfMermaidDiagrams(markdown, {
      signal: controller.signal,
      renderer: async (source) => {
        rendered.push(source);
        return diagramSvg();
      },
      onProgress: (completed) => {
        if (completed === 1) setTimeout(() => controller.abort(), 0);
      },
    });

    expect(rendered).toEqual(["flowchart LR\nA-->B"]);
    expect(diagrams).toHaveLength(1);
  });
});
