import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { colName, displayFormulaValue, evaluateFormula, FormulaError, parseCellRef } from "./formula";
import { editCell, openSpreadsheet, serializeWorkbook } from "./sheet";
import { openPptx, serializePresentation, updateShapeText } from "./slide";
import { htmlToRuns, openDocx, paragraphText, parseWordBlocks, serializeWord } from "./word";
import { decodeXml, encodeXml } from "./xml";

function arrayBuffer(bytes: Uint8Array) {
  return bytes.slice().buffer;
}

describe("xml helpers", () => {
  it("round-trips named and numeric entities", () => {
    expect(decodeXml("A &lt; B &amp;&amp; &#20013; = &#x6587;")).toBe("A < B && 中 = 文");
    expect(decodeXml(encodeXml("a < b & \"c\""))).toBe("a < b & \"c\"");
  });
});

describe("formula engine", () => {
  const grid = new Map<string, number | string>([
    ["0,0", 10],
    ["1,0", 20],
    ["2,0", 30],
    ["0,1", "叶"],
  ]);
  const lookup = {
    getCell(row: number, col: number) {
      return grid.get(`${row},${col}`) ?? null;
    },
  };

  it("parses cell addresses and column names", () => {
    expect(colName(0)).toBe("A");
    expect(colName(26)).toBe("AA");
    expect(parseCellRef("B12")).toMatchObject({ row: 11, col: 1 });
    expect(parseCellRef("Sheet1!$A$1")).toMatchObject({ sheet: "Sheet1", row: 0, col: 0, absCol: true, absRow: true });
  });

  it("evaluates arithmetic, ranges and common Excel functions", () => {
    expect(evaluateFormula("=1+2*3", lookup)).toBe(7);
    expect(evaluateFormula("=SUM(A1:A3)", lookup)).toBe(60);
    expect(evaluateFormula("=AVERAGE(A1:A3)", lookup)).toBe(20);
    expect(evaluateFormula("=IF(A1>5,\"yes\",\"no\")", lookup)).toBe("yes");
    expect(evaluateFormula("=A1&B1", lookup)).toBe("10叶");
    expect(evaluateFormula("=LEFT(B1,1)", lookup)).toBe("叶");
  });

  it("returns Excel-style errors", () => {
    expect(evaluateFormula("=1/0", lookup)).toBeInstanceOf(FormulaError);
    expect(displayFormulaValue(evaluateFormula("=UNKNOWN(1)", lookup))).toBe("#NAME?");
  });
});

describe("WordprocessingML editor codec", () => {
  it("extracts headings, runs and tables", () => {
    const { blocks } = parseWordBlocks(`
      <w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>性能设计</w:t></w:r></w:p>
        <w:p><w:r><w:t>秒开 &amp; 本地优先</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>
    `);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(paragraphText(blocks[0] as never)).toBe("性能设计");
    expect(paragraphText(blocks[1] as never)).toBe("秒开 & 本地优先");
    expect(blocks[2]).toMatchObject({ kind: "table", rows: [[{ text: "A1" }, { text: "B1" }]] });
  });

  it("round-trips an edited DOCX package", () => {
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`),
      "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>一叶 Word</w:t></w:r></w:p></w:body></w:document>`),
    });
    const document = openDocx(arrayBuffer(bytes));
    expect(paragraphText(document.blocks[0] as never)).toBe("一叶 Word");
    const paragraph = document.blocks[0];
    if (paragraph.kind !== "table") {
      paragraph.runs = [{ text: "一叶编辑器" }];
      paragraph.dirty = true;
    }
    const saved = openDocx(arrayBuffer(serializeWord(document)));
    expect(paragraphText(saved.blocks[0] as never)).toBe("一叶编辑器");
  });

  it("converts HTML formatting to Word runs", () => {
    expect(htmlToRuns("<b>粗</b>体")).toEqual([
      { text: "粗", bold: true },
      { text: "体" },
    ]);
  });

  it("does not leak contentEditable span tags into run text", () => {
    const runs = htmlToRuns('<span style="color:#111;font-weight:700">标题</span>正文');
    expect(runs.map((run) => run.text).join("")).toBe("标题正文");
    expect(runs.some((run) => /span|style|font-weight/i.test(run.text))).toBe(false);
    expect(runs.find((run) => run.text.includes("标题"))?.bold).toBe(true);
  });

  it("loads drawing images from the DOCX package", () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const bytes = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><a:blip r:embed="rId4"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`),
      "word/media/image1.png": png,
    });
    const document = openDocx(arrayBuffer(bytes));
    const paragraph = document.blocks[0];
    expect(paragraph.kind).not.toBe("table");
    if (paragraph.kind === "table") return;
    expect(paragraph.runs[0]?.image?.src.startsWith("data:image/png")).toBe(true);
    const saved = openDocx(arrayBuffer(serializeWord(document)));
    const savedParagraph = saved.blocks[0];
    if (savedParagraph.kind !== "table") expect(savedParagraph.runs[0]?.image?.src.startsWith("data:image/png")).toBe(true);
  });
});

describe("SpreadsheetML editor codec", () => {
  it("opens XLSX, evaluates formulas and writes Microsoft-compatible packages", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/sharedStrings.xml": strToU8(`<sst><si><t>姓名</t></si></sst>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>40</v></c><c r="C1"><v>60</v></c><c r="D1"><f>SUM(B1:C1)</f><v>0</v></c></row>
      </sheetData></worksheet>`),
    });
    const workbook = openSpreadsheet(arrayBuffer(bytes), "xlsx");
    expect(workbook.sheets[0]?.name).toBe("数据");
    expect(workbook.sheets[0]?.cells.get(0)?.get(3)?.value).toBe(100);
    editCell(workbook, "数据", 0, 1, "15");
    expect(workbook.sheets[0]?.cells.get(0)?.get(3)?.value).toBe(75);
    const roundtrip = openSpreadsheet(arrayBuffer(serializeWorkbook(workbook)), "xlsx");
    expect(roundtrip.sheets[0]?.cells.get(0)?.get(1)?.value).toBe(15);
    expect(roundtrip.sheets[0]?.cells.get(0)?.get(3)?.value).toBe(75);
  });

  it("parses merged cells from SpreadsheetML", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1"><v>合并</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells></worksheet>`),
    });
    const workbook = openSpreadsheet(arrayBuffer(bytes), "xlsx");
    expect(workbook.sheets[0]?.merges).toEqual([{ r: 0, c: 0, rows: 2, cols: 2 }]);
  });

  it("parses and serializes CSV without going through OOXML", () => {
    const workbook = openSpreadsheet(arrayBuffer(new TextEncoder().encode("a,b\n1,2")), "csv");
    editCell(workbook, "Sheet1", 1, 0, "9");
    expect(new TextDecoder().decode(serializeWorkbook(workbook))).toContain("9,2");
  });
});

describe("PresentationML editor codec", () => {
  it("preserves slide geometry and writes edited text back", () => {
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>极速演示</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    });
    const presentation = openPptx(arrayBuffer(bytes));
    expect(presentation.slides[0]?.shapes[0]).toMatchObject({ x: 0.1, y: 0.1, width: 0.8, height: 0.2, fontSize: 24, bold: true, text: "极速演示" });
    updateShapeText(presentation.slides[0], presentation.slides[0].shapes[0].id, "一叶幻灯片");
    const saved = openPptx(arrayBuffer(serializePresentation(presentation)));
    expect(saved.slides[0]?.shapes[0]?.text).toBe("一叶幻灯片");
  });

  it("reads pictures and tables even when xfrm attributes are reordered", () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
        <p:sp><p:spPr><a:xfrm><a:ext cy="100" cx="800"/><a:off y="50" x="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp>
        <p:pic><p:spPr><a:xfrm><a:off y="200" x="100"/><a:ext cy="150" cx="300"/></a:xfrm></p:spPr><a:blip r:embed="rId2"/></p:pic>
        <p:graphicFrame><p:xfrm><a:off x="100" y="360"/><a:ext cx="800" cy="80"/></p:xfrm><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>左</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>右</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>
      </p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`),
      "ppt/media/image1.png": png,
    });
    const presentation = openPptx(arrayBuffer(bytes));
    const slide = presentation.slides[0];
    expect(slide.shapes.find((shape) => shape.kind !== "image" && shape.kind !== "table")).toMatchObject({ x: 0.1, y: 0.1, width: 0.8, height: 0.2, text: "标题" });
    expect(slide.shapes.find((shape) => shape.kind === "image")?.src?.startsWith("data:image/png")).toBe(true);
    expect(slide.shapes.find((shape) => shape.kind === "table")?.table).toEqual([["左", "右"]]);
  });
});
