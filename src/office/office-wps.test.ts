import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { OfficeSession } from "./core/session";
import { displayFormulaValue, evaluateFormula } from "./formula";
import { autoSum, editCell, fillRight, formatCellDisplay, getCell, mergeCells, openSpreadsheet, serializeWorkbook, setCellFormat, sortRange } from "./sheet";
import { addTextBox, hideSlide, openPptx, serializePresentation, setSlideNotes } from "./slide";
import { applyParagraphStyle, applyRunStyle, findReplaceWord, insertTable, openDocx, paragraphText, serializeWord, setHeaderFooter, wordCount } from "./word";

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

function sampleXlsx(cellsXml: string) {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cellsXml}</sheetData></worksheet>`),
  });
}

function sampleDocx(body: string) {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`),
    "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
  });
}

function samplePptx(text = "首页") {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
    "ppt/presentation.xml": strToU8(`<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
    "ppt/slides/slide1.xml": strToU8(`<p:sld><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  });
}

describe("WPS 文字日常能力", () => {
  it("插入表格、查找替换、页眉页脚与缩进可写回 Word / WPS", () => {
    const document = openDocx(bufferOf(sampleDocx(`<w:p><w:r><w:t>你好世界</w:t></w:r></w:p>`)));
    insertTable(document, 1, 2, 2);
    expect(document.blocks[1]).toMatchObject({ kind: "table" });
    if (document.blocks[1].kind === "table") document.blocks[1].rows[0][0].text = "A1";
    findReplaceWord(document, "世界", "WPS", true);
    expect(paragraphText(document.blocks[0] as never)).toBe("你好WPS");
    if (document.blocks[0].kind !== "table") {
      document.blocks[0] = applyParagraphStyle(document.blocks[0], { indent: 2, lineSpacing: 1.5, pageBreak: true });
      document.blocks[0].runs = applyRunStyle(document.blocks[0].runs, { bold: true, font: "微软雅黑", fontSize: 16, highlight: "yellow" });
    }
    setHeaderFooter(document, "公司页眉", "第 1 页");
    expect(wordCount(document.blocks).characters).toBeGreaterThan(0);
    const saved = openDocx(bufferOf(serializeWord(document)));
    expect(saved.header).toBe("公司页眉");
    expect(saved.footer).toBe("第 1 页");
    expect(saved.blocks[1]).toMatchObject({ kind: "table" });
    expect(paragraphText(saved.blocks[0] as never)).toBe("你好WPS");
    expect(saved.blocks[0]).toMatchObject({ indent: 2, lineSpacing: 1.5, pageBreak: true });
    if (saved.blocks[0].kind !== "table") {
      expect(saved.blocks[0].runs[0]?.font).toBe("微软雅黑");
      expect(saved.blocks[0].runs[0]?.highlight).toBe("yellow");
      expect(saved.blocks[0].runs[0]?.bold).toBe(true);
    }
  });

  it("Word 超链接与撤销", () => {
    const session = new OfficeSession("word", "docx", openDocx(bufferOf(sampleDocx(`<w:p><w:hyperlink w:anchor="https://example.com"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>`))));
    if (session.model.type !== "word") throw new Error("not word");
    expect((session.model.blocks[0] as { runs: Array<{ hyperlink?: string }> }).runs[0]?.hyperlink).toBe("https://example.com");
    session.mutate({ op: "wordFindReplace", query: "链接", replacement: "官网", all: true });
    expect(paragraphText(session.model.blocks[0] as never)).toBe("官网");
    session.undoOnce();
    expect(paragraphText(session.model.blocks[0] as never)).toBe("链接");
  });
});

describe("WPS 表格日常能力", () => {
  it("日期/货币/百分比、合并、排序、填充、自动求和可写回", () => {
    const workbook = openSpreadsheet(bufferOf(sampleXlsx(`
      <row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>4</v></c></row>
    `)), "xlsx");
    editCell(workbook, "Sheet1", 2, 0, "2024-01-15");
    editCell(workbook, "Sheet1", 2, 1, "¥12.5");
    editCell(workbook, "Sheet1", 2, 2, "15%");
    expect(getCell(workbook.sheets[0], 2, 0)?.format?.numFmt).toBe("date");
    expect(getCell(workbook.sheets[0], 2, 1)?.value).toBe(12.5);
    expect(getCell(workbook.sheets[0], 2, 2)?.value).toBe(0.15);
    expect(formatCellDisplay(getCell(workbook.sheets[0], 2, 2)!)).toBe("15.00%");
    mergeCells(workbook, "Sheet1", 0, 0, 1, 2, true);
    sortRange(workbook, "Sheet1", 0, 0, 2, 2, 0, true);
    expect(getCell(workbook.sheets[0], 0, 0)?.value).toBe(2);
    fillRight(workbook, "Sheet1", 0, 0, 1, 3);
    setCellFormat(workbook, "Sheet1", 0, 0, 1, 1, { bold: true, numFmt: "number", decimals: 1 });
    autoSum(workbook, "Sheet1", 0, 4, 2, 1);
    const reopened = openSpreadsheet(bufferOf(serializeWorkbook(workbook)), "xlsx");
    expect(reopened.sheets[0].merges?.[0]).toMatchObject({ r: 0, c: 0, cols: 2 });
    expect(getCell(reopened.sheets[0], 2, 0)?.format?.numFmt).toBe("date");
    const session = new OfficeSession("spreadsheet", "xlsx", openSpreadsheet(bufferOf(sampleXlsx(`<row r="1"><c r="A1"><v>9</v></c></row>`)), "xlsx"));
    session.mutate({ op: "sheetRename", name: "Sheet1", next: "数据" });
    if (session.model.type !== "spreadsheet") throw new Error("not sheet");
    expect(session.model.sheets[0].name).toBe("数据");
    session.mutate({ op: "sheetAdd", name: "汇总" });
    expect(session.model.sheets.map((sheet) => sheet.name)).toEqual(["数据", "汇总"]);
    const named = openSpreadsheet(bufferOf(session.serialize()), "xlsx");
    expect(named.sheets.map((sheet) => sheet.name)).toEqual(["数据", "汇总"]);
    session.undoOnce();
    expect(session.model.sheets).toHaveLength(1);
  });

  it("对齐 WPS / Excel 扩展函数", () => {
    const lookup = lookupFrom({
      "0,0": 10,
      "1,0": 20,
      "2,0": 30,
      "0,1": "Apple",
      "1,1": "Banana",
      "2,1": "apple",
    });
    const cases: Array<[string, string | number | boolean]> = [
      ["=IFS(FALSE,\"a\",TRUE,\"b\")", "b"],
      ["=SWITCH(2,1,\"a\",2,\"b\",\"c\")", "b"],
      ["=XOR(TRUE,TRUE,TRUE)", true],
      ["=CONCATENATE(B1,\"-\",A1)", "Apple-10"],
      ["=XLOOKUP(\"Apple\",B1:B3,A1:A3)", 10],
      ["=INDIRECT(\"A1\")", 10],
      ["=QUOTIENT(10,3)", 3],
      ["=FACT(5)", 120],
      ["=GCD(24,18)", 6],
      ["=LCM(4,6)", 12],
      ["=EVEN(3)", 4],
      ["=ODD(4)", 5],
      ["=ISEVEN(4)", true],
      ["=DEGREES(PI())", 180],
      ["=YEAR(DATE(2024,1,15))", 2024],
      ["=MONTH(DATE(2024,1,15))", 1],
      ["=DAYS(DATE(2024,1,10),DATE(2024,1,1))", 9],
      ["=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7))", 5],
    ];
    for (const [formula, expected] of cases) {
      expect(displayFormulaValue(evaluateFormula(formula, lookup)), formula).toBe(displayFormulaValue(expected));
    }
    expect(evaluateFormula("=PMT(0.01,12,1000)", lookup) as number).toBeCloseTo(-88.8488, 3);
    expect(evaluateFormula("=STDEV(A1:A3)", lookup) as number).toBeCloseTo(10, 5);
  });
});

describe("WPS 演示日常能力", () => {
  it("备注、隐藏、文本框与版式可写回", () => {
    const presentation = openPptx(bufferOf(samplePptx()));
    setSlideNotes(presentation.slides[0], "演讲备注");
    hideSlide(presentation.slides[0], true);
    addTextBox(presentation.slides[0], { text: "额外文本", fill: "#ffcc00" });
    const session = new OfficeSession("presentation", "pptx", openPptx(bufferOf(samplePptx())));
    session.mutate({ op: "slideAddTextBox", index: 0 });
    session.mutate({ op: "slideNotes", index: 0, notes: "要点" });
    session.mutate({ op: "slideHide", index: 0, hidden: true });
    session.mutate({ op: "slideLayout", index: 0, layout: "twoContent" });
    if (session.model.type !== "presentation") throw new Error("not ppt");
    expect(session.model.slides[0].notes).toBe("要点");
    expect(session.model.slides[0].hidden).toBe(true);
    const roundtrip = openPptx(bufferOf(serializePresentation(session.model)));
    expect(roundtrip.slides[0].notes).toBe("要点");
    expect(roundtrip.slides[0].hidden).toBe(true);
    expect(roundtrip.slides[0].shapes.length).toBeGreaterThan(1);
    session.undoOnce();
    session.undoOnce();
    expect(session.model.slides[0].hidden).toBe(false);
  });
});

describe("Agent 办公摘录", () => {
  it("inspect 与 excerpt 返回有限文本而不是整包 OOXML", () => {
    const word = new OfficeSession("word", "docx", openDocx(bufferOf(sampleDocx(`<w:p><w:r><w:t>秒开本地文档</w:t></w:r></w:p>`))));
    expect(word.inspect().kind).toBe("word");
    expect(word.inspect().word?.preview.some((line) => line.includes("秒开本地文档"))).toBe(true);
    expect(word.excerpt({ offset: 0, count: 4 })).toContain("秒开本地文档");

    const book = new OfficeSession("spreadsheet", "xlsx", openSpreadsheet(bufferOf(sampleXlsx(`<c r="A1"><v>12</v></c>`)), "xlsx"));
    expect(book.inspect().kind).toBe("spreadsheet");
    expect(book.excerpt({ sheet: "Sheet1", row: 0, col: 0, rowCount: 1, colCount: 1 })).toContain("A1");

    const deck = new OfficeSession("presentation", "pptx", openPptx(bufferOf(samplePptx("封面"))));
    expect(deck.inspect().kind).toBe("presentation");
    expect(deck.excerpt({ slide: 0 })).toContain("封面");
  });
});
