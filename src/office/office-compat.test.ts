import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { OfficeSession } from "./core/session";
import { displayFormulaValue, evaluateFormula, shiftFormula, translateFormula } from "./formula";
import { matchCriteria } from "./formula-functions";
import { editCell, fillDown, insertRows, openSpreadsheet, serializeWorkbook } from "./sheet";
import { duplicateSlide, openPptx, serializePresentation } from "./slide";
import { applyParagraphStyle, openDocx, paragraphText, serializeWord } from "./word";

function bufferOf(bytes: Uint8Array) {
  return bytes.slice().buffer;
}

function lookupFrom(cells: Record<string, number | string | boolean>) {
  return {
    getCell(row: number, col: number) {
      return cells[`${row},${col}`] ?? null;
    },
  };
}

describe("Microsoft Excel 公式对照", () => {
  const lookup = lookupFrom({
    "0,0": 10,
    "1,0": 20,
    "2,0": 30,
    "3,0": 5,
    "0,1": "Apple",
    "1,1": "Banana",
    "2,1": "apple",
    "0,2": 100,
    "1,2": 200,
    "2,2": 300,
  });

  const cases: Array<[string, string | number | boolean]> = [
    ["=SUM(A1:A3)", 60],
    ["=AVERAGE(A1:A3)", 20],
    ["=MIN(A1:A4)", 5],
    ["=MAX(A1:A4)", 30],
    ["=COUNT(A1:A4)", 4],
    ["=COUNTA(A1:B3)", 6],
    ["=IF(A1>5,\"yes\",\"no\")", "yes"],
    ["=ROUND(2.56,1)", 2.6],
    ["=ROUNDUP(2.11,0)", 3],
    ["=INT(-1.2)", -2],
    ["=MOD(10,3)", 1],
    ["=POWER(2,10)", 1024],
    ["=ABS(-8)", 8],
    ["=LEFT(B1,1)", "A"],
    ["=LEN(B1)", 5],
    ["=UPPER(B1)", "APPLE"],
    ["=PROPER(B1)", "Apple"],
    ["=CONCAT(B1,\"-\",A1)", "Apple-10"],
    ["=IFERROR(1/0,\"err\")", "err"],
    ["=COUNTIF(A1:A4,\">15\")", 2],
    ["=SUMIF(A1:A4,\">15\")", 50],
    ["=INDEX(A1:C3,2,3)", 200],
    ["=VLOOKUP(20,A1:C3,3,FALSE)", 200],
    ["=INDEX(C1:C3,2,1)", 200],
    ["=MATCH(30,A1:A3,0)", 3],
    ["=PRODUCT(A1,A4)", 50],
    ["=TEXTJOIN(\",\",TRUE,B1:B2)", "Apple,Banana"],
    ["=AND(A1>0,A4<10)", true],
    ["=OR(FALSE,A1=10)", true],
    ["=NOT(FALSE)", true],
    ["=CHOOSE(2,\"a\",\"b\",\"c\")", "b"],
    ["=LARGE(A1:A4,1)", 30],
    ["=SMALL(A1:A4,1)", 5],
    ["=MEDIAN(A1:A4)", 15],
    ["=SUMPRODUCT(A1:A3,C1:C3)", 14000],
    ["=FIND(\"p\",B1)", 2],
    ["=SEARCH(\"P\",B1)", 2],
    ["=SUBSTITUTE(B1,\"p\",\"P\")", "APPle"],
    ["=EXACT(B1,B3)", false],
    ["=N(TRUE)", 1],
    ["=PI()>3", true],
    ["=COUNTIFS(A1:A4,\">5\",A1:A4,\"<30\")", 2],
    ["=SUMIFS(C1:C3,A1:A3,\">10\")", 500],
  ];

  it("逐项对齐 Microsoft / WPS / OnlyOffice 常见函数语义", () => {
    for (const [formula, expected] of cases) {
      const value = evaluateFormula(formula, lookup);
      expect(displayFormulaValue(value), formula).toBe(displayFormulaValue(expected));
    }
  });

  it("支持 COUNTIF 通配符与比较条件", () => {
    expect(matchCriteria("Apple", "A*")).toBe(true);
    expect(matchCriteria("Apple", "<>Banana")).toBe(true);
    expect(evaluateFormula("=COUNTIF(B1:B3,\"A*\")", lookup)).toBe(2);
  });

  it("百分比字面量与相对引用填充", () => {
    expect(evaluateFormula("=15%", lookup)).toBe(0.15);
    expect(translateFormula("=A1+B1", 1, 0)).toBe("=A2+B2");
    expect(translateFormula("=$A$1+B1", 2, 1)).toBe("=$A$1+C3");
    expect(shiftFormula("=A2", { rowAt: 1, rowDelta: 1 })).toBe("=A3");
  });
});

describe("Excel 编辑命令", () => {
  it("插入行后相对引用下移，撤销可恢复", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>
        <row r="1"><c r="A1"><v>1</v></c></row>
        <row r="2"><c r="A2"><v>2</v></c></row>
        <row r="3"><c r="A3"><f>SUM(A1:A2)</f><v>0</v></c></row>
      </sheetData></worksheet>`),
    });
    const workbook = openSpreadsheet(bufferOf(bytes), "xlsx");
    expect(workbook.sheets[0]?.cells.get(2)?.get(0)?.value).toBe(3);
    insertRows(workbook, "Sheet1", 0, 1);
    expect(workbook.sheets[0]?.cells.get(3)?.get(0)?.formula).toBe("SUM(A2:A3)");
    expect(workbook.sheets[0]?.cells.get(3)?.get(0)?.value).toBe(3);
    editCell(workbook, "Sheet1", 0, 0, "15%");
    expect(workbook.sheets[0]?.cells.get(0)?.get(0)?.value).toBe(0.15);
    fillDown(workbook, "Sheet1", 0, 0, 2, 1);
    expect(workbook.sheets[0]?.cells.get(1)?.get(0)?.value).toBe(0.15);
    const session = new OfficeSession("spreadsheet", "xlsx", openSpreadsheet(bufferOf(serializeWorkbook(workbook)), "xlsx"));
    session.mutate({ op: "sheetEdit", name: "Sheet1", row: 0, col: 0, input: "9" });
    expect(session.model.type === "spreadsheet" && session.model.sheets[0].cells.get(0)?.get(0)?.value).toBe(9);
    session.undoOnce();
    expect(session.model.type === "spreadsheet" && session.model.sheets[0].cells.get(0)?.get(0)?.value).toBe(0.15);
  });
});

describe("Word 列表与样式写回", () => {
  it("把项目符号写成 Microsoft Word numbering 部件", () => {
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`),
      "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>条目</w:t></w:r></w:p></w:body></w:document>`),
      "word/numbering.xml": strToU8(`<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`),
    });
    const document = openDocx(bufferOf(bytes));
    expect(document.blocks[0]).toMatchObject({ kind: "paragraph", list: { type: "bullet", numId: 1 } });
    if (document.blocks[0].kind !== "table") {
      document.blocks[0] = applyParagraphStyle(document.blocks[0], { kind: "heading", level: 2 });
      document.blocks[0].runs = [{ text: "标题二" }];
    }
    const saved = openDocx(bufferOf(serializeWord(document)));
    expect(saved.blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(paragraphText(saved.blocks[0] as never)).toBe("标题二");
    expect(new TextDecoder().decode(serializeWord(document))).toBeTruthy();
    const session = new OfficeSession("word", "docx", openDocx(bufferOf(bytes)));
    session.mutate({ op: "wordInsert", index: 1, block: { kind: "paragraph", runs: [{ text: "新段" }] } });
    expect(session.model.type === "word" && paragraphText(session.model.blocks[1] as never)).toBe("新段");
    session.undoOnce();
    expect(session.model.type === "word" && session.model.blocks.length).toBe(1);
  });
});

describe("PowerPoint 幻灯片操作", () => {
  it("复制幻灯片并更新 presentation 关系，供 Microsoft / WPS 打开", () => {
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
      "ppt/presentation.xml": strToU8(`<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="1000" cy="500"/></p:presentation>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>首页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    });
    const presentation = openPptx(bufferOf(bytes));
    duplicateSlide(presentation, 0);
    expect(presentation.slides).toHaveLength(2);
    const saved = serializePresentation(presentation);
    const xml = new TextDecoder().decode(saved);
    expect(xml).toContain("ppt/slides/slide2.xml");
    const session = new OfficeSession("presentation", "pptx", openPptx(bufferOf(bytes)));
    session.mutate({ op: "slideAdd" });
    expect(session.model.type === "presentation" && session.model.slides.length).toBe(2);
    session.undoOnce();
    expect(session.model.type === "presentation" && session.model.slides.length).toBe(1);
  });
});
