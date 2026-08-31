import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocx, paragraphText } from "./word";
import { openPptx } from "./slide";
import { openSpreadsheet } from "./sheet";

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
    expect(document.blocks.some((block) => block.kind !== "table" && block.list?.type === "bullet")).toBe(true);
    expect(document.blocks.some((block) => block.kind !== "table" && block.list?.type === "number")).toBe(true);
  });

  it("parses the python-pptx sample: cover picture, table, title layout", () => {
    const presentation = openPptx(load("leafmark-sample.pptx"));
    expect(presentation.slides).toHaveLength(3);
    const cover = presentation.slides[0];
    expect(cover.shapes.some((shape) => shape.kind === "image" && shape.src?.startsWith("data:image/"))).toBe(true);
    expect(cover.shapes.some((shape) => shape.text.includes("一叶演示文稿样张"))).toBe(true);
    expect(cover.title).toContain("一叶演示文稿样张");
    const content = presentation.slides[1];
    expect(content.title).toContain("图片与表格应同时可见");
    expect(content.shapes.some((shape) => shape.kind === "image" && shape.src?.startsWith("data:image/"))).toBe(true);
    const table = content.shapes.find((shape) => shape.kind === "table");
    expect(table?.table?.some((row) => row.some((cell) => cell.text.includes("Word")))).toBe(true);
    expect(table?.table?.[0]?.[0]?.colSpan).toBe(3);
    const layout = presentation.slides[2];
    expect(layout.shapes.some((shape) => shape.text.includes("版式占位符标题"))).toBe(true);
    expect(cover.shapes.some((shape) => shape.text.includes("1/27/13") || shape.text.includes("‹#›"))).toBe(false);
    expect(content.shapes.some((shape) => shape.text.includes("1/27/13") || shape.text.includes("‹#›"))).toBe(false);
  });

  it("parses the spreadsheet sample: merged header, freeze, column widths, formulas", () => {
    const workbook = openSpreadsheet(load("leafmark-sample.xlsx"), "xlsx");
    const sheet = workbook.sheets[0];
    expect(sheet?.name).toBe("数据");
    expect(sheet?.merges).toEqual([{ r: 0, c: 0, rows: 1, cols: 4 }]);
    expect(sheet?.freeze).toEqual({ row: 1, col: 0 });
    expect(sheet?.colWidths?.get(0)).toBe(18);
    expect(sheet?.cells.get(0)?.get(0)?.value).toBe("一叶表格视觉样张");
    expect(sheet?.cells.get(2)?.get(3)?.formula).toBe("B3*C3");
    expect(sheet?.cells.get(2)?.get(3)?.value).toBe(80);
    expect(sheet?.cells.get(5)?.get(3)?.value).toBe(215);
  });
});
