import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocx, paragraphText } from "./word";
import { openPptx } from "./slide";

function load(name: string) {
  const bytes = readFileSync(resolve("public/office-fixtures", name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("real Office visual fixtures", () => {
  it("parses the python-docx sample: images, hyperlink URL, merged table, header", () => {
    const document = openDocx(load("leafmark-sample.docx"));
    const text = document.blocks
      .map((block) => (block.kind === "table" ? block.rows.flat().map((cell) => cell.text).join(" ") : paragraphText(block)))
      .join("\n");
    expect(text).toContain("一叶办公文档视觉样张");
    expect(text).toContain("打开官网链接");
    const images = document.blocks.flatMap((block) => block.kind === "table" ? [] : block.runs.filter((run) => run.image));
    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(images.every((run) => run.image?.src.startsWith("data:image/"))).toBe(true);
    expect(images.some((run) => run.image?.wrap === "square" && run.image?.float === "right")).toBe(true);
    expect(document.blocks.some((block) => block.kind !== "table" && block.runs.some((run) => run.hyperlink === "https://github.com/EthanBird/leafmark"))).toBe(true);
    const table = document.blocks.find((block) => block.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind === "table") {
      expect(table.rows[0]?.[1]?.colSpan).toBe(2);
      expect(table.rows[1]?.[0]?.rowSpan).toBe(2);
      expect(table.rows[2]?.[0]?.hidden).toBe(true);
    }
    expect(document.header).toContain("LeafMark 视觉样张");
  });

  it("parses the python-pptx sample: cover picture, table, title layout", () => {
    const presentation = openPptx(load("leafmark-sample.pptx"));
    expect(presentation.slides).toHaveLength(3);
    const cover = presentation.slides[0];
    expect(cover.shapes.some((shape) => shape.kind === "image" && shape.src?.startsWith("data:image/"))).toBe(true);
    expect(cover.shapes.some((shape) => shape.text.includes("一叶演示文稿样张"))).toBe(true);
    const content = presentation.slides[1];
    expect(content.shapes.some((shape) => shape.kind === "image" && shape.src?.startsWith("data:image/"))).toBe(true);
    expect(content.shapes.some((shape) => shape.kind === "table" && (shape.table?.[0] ?? []).includes("Word"))).toBe(true);
    const layout = presentation.slides[2];
    expect(layout.shapes.some((shape) => shape.text.includes("版式占位符标题"))).toBe(true);
    expect(cover.shapes.some((shape) => shape.text.includes("1/27/13") || shape.text.includes("‹#›"))).toBe(false);
    expect(content.shapes.some((shape) => shape.text.includes("1/27/13") || shape.text.includes("‹#›"))).toBe(false);
  });
});
