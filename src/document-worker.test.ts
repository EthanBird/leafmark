import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "@e965/xlsx";
import { decodeXml, openDocx, openPptx, openSpreadsheet, parseWordBlocks } from "./document-worker";

function arrayBuffer(bytes: Uint8Array) {
  return bytes.slice().buffer;
}

describe("document worker parsers", () => {
  it("extracts headings, paragraphs and tables from WordprocessingML", () => {
    const blocks = parseWordBlocks(`
      <w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>性能设计</w:t></w:r></w:p>
        <w:p><w:r><w:t>秒开 &amp; 本地优先</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>
    `);

    expect(blocks).toEqual([
      { kind: "heading", text: "性能设计", level: 2 },
      { kind: "paragraph", text: "秒开 & 本地优先" },
      { kind: "table", rows: [["A1", "B1"]] },
    ]);
  });

  it("decodes numeric and named XML entities", () => {
    expect(decodeXml("A &lt; B &amp;&amp; &#20013; = &#x6587;")).toBe("A < B && 中 = 文");
  });

  it("opens a minimal DOCX package without touching the UI thread", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>一叶 Word</w:t></w:r></w:p></w:body></w:document>`),
    });
    const result = openDocx("docx-fixture", arrayBuffer(bytes));
    expect(result.blocks[0]).toEqual({ kind: "paragraph", text: "一叶 Word" });
  });

  it("opens an XLSX workbook and returns only the initial row window", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["姓名", "分数"], ["一叶", 100]]), "数据");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const result = openSpreadsheet("xlsx-fixture", bytes);
    expect(result.sheets).toEqual([{ name: "数据", rows: 2, columns: 2 }]);
    expect(result.active?.rows).toEqual([["姓名", "分数"], ["一叶", "100"]]);
  });

  it("opens a minimal PPTX package and preserves slide geometry", () => {
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld><p:cSld><p:sp><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>极速演示</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:sld>`),
    });
    const result = openPptx("pptx-fixture", arrayBuffer(bytes));
    expect(result.active?.title).toBe("极速演示");
    expect(result.active?.shapes[0]).toMatchObject({ x: 0.1, y: 0.1, width: 0.8, height: 0.2, fontSize: 24, bold: true });
  });
});
