// @vitest-environment jsdom

import { beforeAll, expect, it } from "vitest";
import pdfMake from "pdfmake/build/pdfmake";
import { vfs as pdfVfs } from "pdfmake/build/vfs_fonts";
import type { Content, TDocumentDefinitions, TFontDictionary } from "pdfmake/interfaces";
import { preparePdfMermaidDiagrams } from "./pdf-mermaid";

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 120, height: 24 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 120,
  });
});

it("renders a real Mermaid flowchart to PDF-safe SVG", async () => {
  const diagrams = await preparePdfMermaidDiagrams(
    "```mermaid\nflowchart LR\nA[开始] --> B[完成]\n```",
  );
  expect(diagrams).toHaveLength(1);
  expect(diagrams[0].svg).toContain("<svg");
  expect(diagrams[0].svg).not.toMatch(/foreignObject|<style/i);
});

it("converts a real Mermaid journey diagram's HTML labels to SVG text", async () => {
  const diagrams = await preparePdfMermaidDiagrams([
    "```mermaid",
    "journey",
    "  title My working day",
    "  section Go to work",
    "    Make tea: 5: Me",
    "    Go upstairs: 3: Me",
    "```",
  ].join("\n"));
  expect(diagrams).toHaveLength(1);
  expect(diagrams[0].svg).not.toMatch(/foreignObject|<style/i);
  expect(diagrams[0].svg).toContain("Go to work");
  expect(diagrams[0].svg).toContain("Make tea");
});

it("feeds real Mermaid SVGs through pdfmake without rasterizing or failing", async () => {
  const diagrams = await preparePdfMermaidDiagrams([
    "```mermaid",
    "flowchart LR",
    "A[Start] --> B[Done]",
    "```",
    "",
    "```mermaid",
    "journey",
    "  title Working day",
    "  section Work",
    "    Write docs: 5: Me",
    "```",
  ].join("\n"));
  const definition: TDocumentDefinitions = {
    content: diagrams.map((diagram) => ({
      svg: diagram.svg,
      width: diagram.width,
      height: diagram.height,
    })) as Content[],
    defaultStyle: { font: "LeafMark" },
  };
  const fonts: TFontDictionary = {
    LeafMark: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  };
  const pdf = pdfMake.createPdf(definition, undefined, fonts, pdfVfs);
  const bytes = await new Promise<Uint8Array>((resolve) => {
    pdf.getBuffer((value) => resolve(new Uint8Array(value)));
  });

  expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  expect(bytes.byteLength).toBeGreaterThan(5_000);
});
