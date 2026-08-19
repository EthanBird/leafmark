import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { colName, displayFormulaValue, evaluateFormula, FormulaError, parseCellRef } from "./formula";
import { editCell, openSpreadsheet, readViewport, serializeWorkbook } from "./sheet";
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

  it("resolves hyperlink rIds to real URLs", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rId5"><w:r><w:t>官网</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`),
      "word/_rels/document.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://leafmark.app" TargetMode="External"/></Relationships>`),
    });
    const document = openDocx(arrayBuffer(bytes));
    const paragraph = document.blocks[0];
    expect(paragraph.kind).not.toBe("table");
    if (paragraph.kind === "table") return;
    expect(paragraph.runs[0]?.hyperlink).toBe("https://leafmark.app");
  });

  it("parses table gridSpan and vMerge into HTML spans", () => {
    const { blocks } = parseWordBlocks(`
      <w:document><w:body>
        <w:tbl>
          <w:tr>
            <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>左上</w:t></w:r></w:p></w:tc>
            <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>跨列</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:body></w:document>
    `);
    expect(blocks[0]?.kind).toBe("table");
    if (blocks[0]?.kind !== "table") return;
    expect(blocks[0].rows[0]?.[0]).toMatchObject({ text: "左上", rowSpan: 2 });
    expect(blocks[0].rows[0]?.[1]).toMatchObject({ text: "跨列", colSpan: 2 });
    expect(blocks[0].rows[1]?.[0]?.hidden).toBe(true);
    expect(blocks[0].rows[1]?.[1]?.text).toBe("B2");
    expect(blocks[0].rows[1]?.[2]?.text).toBe("C2");
  });

  it("treats ListBullet / ListNumber paragraph styles as lists without numPr", () => {
    const { blocks } = parseWordBlocks(`
      <w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>圆点</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>编号</w:t></w:r></w:p>
      </w:body></w:document>
    `);
    expect(blocks[0]).toMatchObject({ list: { type: "bullet", numId: 1 } });
    expect(blocks[1]).toMatchObject({ list: { type: "number", numId: 2 } });
  });

  it("marks floating drawings as wrap/float images", () => {
    const { blocks } = parseWordBlocks(`
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>
        <w:p><w:r><w:drawing><wp:anchor><wp:extent cx="914400" cy="914400"/><wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH><wp:wrapSquare wrapText="bothSides"/><a:graphic><a:graphicData><a:blip r:embed="rId4"/></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>
      </w:body></w:document>
    `, new Map(), new Map([["rId4", "data:image/png;base64,xx"]]));
    const paragraph = blocks[0];
    expect(paragraph.kind).not.toBe("table");
    if (paragraph.kind === "table") return;
    expect(paragraph.runs[0]?.image).toMatchObject({ wrap: "square", float: "right", src: "data:image/png;base64,xx" });
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

  it("parses column widths into the viewport", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`),
    });
    const workbook = openSpreadsheet(arrayBuffer(bytes), "xlsx");
    expect(workbook.sheets[0]?.colWidths?.get(0)).toBe(20);
    expect(readViewport(workbook, "数据", 0, 8, 0, 8).colWidths).toEqual([[0, 20]]);
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
    expect(slide.shapes.find((shape) => shape.kind === "table")?.table).toEqual([[{ text: "左" }, { text: "右" }]]);
  });

  it("reads slide background images and layout placeholders", () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdBg"/></a:blipFill></p:bgPr></p:bg><p:spTree></p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdBg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/bg.png"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`),
      "ppt/media/bg.png": png,
      "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>版式标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`),
    });
    const presentation = openPptx(arrayBuffer(bytes));
    const slide = presentation.slides[0];
    expect(slide.backgroundImage?.startsWith("data:image/png")).toBe(true);
    expect(slide.shapes.some((shape) => shape.fromLayout && shape.text === "版式标题")).toBe(true);
  });

  it("parses DrawingML table gridSpan / vMerge and prefers text shapes for titles", () => {
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
        <p:graphicFrame><p:xfrm><a:off x="100" y="200"/><a:ext cx="800" cy="200"/></p:xfrm><a:tbl>
          <a:tr><a:tc gridSpan="2"><a:tcPr/><a:txBody><a:p><a:r><a:t>跨列</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:tcPr/><a:txBody><a:p/></a:txBody></a:tc></a:tr>
          <a:tr><a:tc><a:tcPr><a:vMerge val="restart"/></a:tcPr><a:txBody><a:p><a:r><a:t>跨行</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          <a:tr><a:tc><a:tcPr><a:vMerge/></a:tcPr><a:txBody><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B3</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl></p:graphicFrame>
        <p:sp><p:spPr><a:xfrm><a:off x="100" y="40"/><a:ext cx="800" cy="80"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>正确标题</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`),
    });
    const slide = openPptx(arrayBuffer(bytes)).slides[0];
    expect(slide.title).toBe("正确标题");
    const table = slide.shapes.find((shape) => shape.kind === "table")?.table;
    expect(table?.[0]?.[0]).toMatchObject({ text: "跨列", colSpan: 2 });
    expect(table?.[0]?.[1]?.hidden).toBe(true);
    expect(table?.[1]?.[0]).toMatchObject({ text: "跨行", rowSpan: 2 });
    expect(table?.[2]?.[0]?.hidden).toBe(true);
  });
});
