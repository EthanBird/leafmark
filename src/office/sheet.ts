import * as XLSX from "@e965/xlsx";
import { displayFormulaValue, evaluateFormula, formatCellRef, FormulaError, shiftFormula, translateFormula, type FormulaResult, type SheetLookup } from "./formula";
import { excelSerialFromYmd, ymdFromExcelSerial } from "./formula-types";
import { clonePackage, findPackagePart, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";
import { decodeXml, encodedTextNode, encodeXml, xmlAttr } from "./xml";

export type SheetNumFmt = "general" | "number" | "percent" | "currency" | "date" | "text" | "scientific";

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  wrap?: boolean;
  color?: string;
  fill?: string;
  numFmt?: SheetNumFmt;
  decimals?: number;
}

export interface SheetMerge {
  r: number;
  c: number;
  rows: number;
  cols: number;
}

export interface SheetCell {
  value: FormulaResult;
  formula?: string;
  type?: "n" | "s" | "b" | "e" | "str";
  style?: number;
  format?: CellFormat;
  originalXml?: string;
  dirty?: boolean;
}

export interface SheetModel {
  name: string;
  rows: number;
  cols: number;
  cells: Map<number, Map<number, SheetCell>>;
  originalXml?: string;
  path: string;
  colWidths?: Map<number, number>;
  rowHeights?: Map<number, number>;
  merges?: SheetMerge[];
  freeze?: { row: number; col: number };
  filter?: { r: number; c: number; rows: number; cols: number };
  hiddenRows?: Set<number>;
  hiddenCols?: Set<number>;
}

export interface WorkbookModel {
  type: "spreadsheet";
  format: string;
  sheets: SheetModel[];
  sharedStrings: string[];
  files?: OfficePackage;
  editable: boolean;
  viaSheetJs?: boolean;
}

export interface ViewportCell {
  r: number;
  c: number;
  display: string;
  formula: string;
  type: string;
  align?: string;
  bold?: boolean;
  wrap?: boolean;
  color?: string;
  fill?: string;
  merge?: SheetMerge;
}

export interface SheetViewport {
  name: string;
  rows: number;
  cols: number;
  rowStart: number;
  colStart: number;
  cells: ViewportCell[];
  freeze?: { row: number; col: number };
  merges?: SheetMerge[];
}

function cellMap() {
  return new Map<number, Map<number, SheetCell>>();
}

function setCell(sheet: SheetModel, row: number, col: number, cell: SheetCell) {
  let line = sheet.cells.get(row);
  if (!line) {
    line = new Map();
    sheet.cells.set(row, line);
  }
  line.set(col, cell);
  sheet.rows = Math.max(sheet.rows, row + 1);
  sheet.cols = Math.max(sheet.cols, col + 1);
}

export function getCell(sheet: SheetModel, row: number, col: number) {
  return sheet.cells.get(row)?.get(col);
}

export function parseCellAddress(address: string) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(address);
  if (!match) return { row: 0, col: 0 };
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

export function openSpreadsheet(buffer: ArrayBuffer, format: string): WorkbookModel {
  const normalized = format.toLowerCase();
  if (normalized === "csv") return openCsv(buffer);
  if (normalized === "xlsx") {
    try {
      return openXlsx(buffer);
    } catch {
      return openViaSheetJs(buffer, normalized);
    }
  }
  return openViaSheetJs(buffer, normalized);
}

function openXlsx(buffer: ArrayBuffer): WorkbookModel {
  const files = unzipPackage(buffer);
  const sharedStrings = parseSharedStrings(packageText(files, "xl/sharedStrings.xml", false));
  const workbook = packageText(files, "xl/workbook.xml");
  const rels = parseRels(packageText(files, "xl/_rels/workbook.xml.rels", false));
  const sheets: SheetModel[] = [];
  for (const sheetTag of workbook.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)) {
    const name = xmlAttr(sheetTag[0], "name") || `Sheet${sheets.length + 1}`;
    const rId = xmlAttr(sheetTag[0], "r:id") || xmlAttr(sheetTag[0], "id");
    const target = rels.get(rId) ?? `worksheets/sheet${sheets.length + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = packageText(files, path, false) || packageText(files, path.replace(/^xl\//, "xl/worksheets/"), false);
    if (!xml) continue;
    sheets.push(parseSheet(name, path, xml, sharedStrings));
  }
  if (!sheets.length) {
    const fallback = findPackagePart(files, /xl\/worksheets\/sheet\d+\.xml$/);
    fallback.forEach((path, index) => {
      sheets.push(parseSheet(`Sheet${index + 1}`, path, packageText(files, path), sharedStrings));
    });
  }
  applyParsedStyles(sheets, parseStyles(packageText(files, "xl/styles.xml", false)));
  const workbookModel: WorkbookModel = {
    type: "spreadsheet",
    format: "xlsx",
    sheets,
    sharedStrings,
    files,
    editable: true,
  };
  recalcWorkbook(workbookModel);
  return workbookModel;
}

function parseRels(xml: string) {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)) {
    rels.set(xmlAttr(match[0], "Id"), xmlAttr(match[0], "Target"));
  }
  return rels;
}

function parseSharedStrings(xml: string) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:[\w.-]+:)?si\b[\s\S]*?<\/(?:[\w.-]+:)?si>/g)].map((item) =>
    [...item[0].matchAll(/<(?:[\w.-]+:)?t\b(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
      .map((match) => decodeXml(match[1]))
      .join(""),
  );
}

function parseSheet(name: string, path: string, xml: string, sharedStrings: string[]): SheetModel {
  const sheet: SheetModel = { name, rows: 0, cols: 0, cells: cellMap(), originalXml: xml, path };
  const dimension = xmlAttr(/<(?:[\w.-]+:)?dimension\b[^>]*>/.exec(xml)?.[0] ?? "", "ref");
  if (dimension.includes(":")) {
    const end = parseCellAddress(dimension.split(":")[1] ?? "A1");
    sheet.rows = Math.max(sheet.rows, end.row + 1);
    sheet.cols = Math.max(sheet.cols, end.col + 1);
  }
  for (const cellXml of xml.matchAll(/<(?:[\w.-]+:)?c\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?c>|<c\b[^>]*\/>/g)) {
    const token = cellXml[0];
    const address = xmlAttr(token, "r");
    if (!address) continue;
    const { row, col } = parseCellAddress(address);
    const type = xmlAttr(token, "t") || "n";
    const style = Number(xmlAttr(token, "s"));
    const formula = decodeXml(/<(?:[\w.-]+:)?f\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?f>/.exec(token)?.[1] ?? "");
    const raw = decodeXml(/<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/.exec(token)?.[1] ?? "");
    const inline = [...token.matchAll(/<(?:[\w.-]+:)?is\b[\s\S]*?<(?:[\w.-]+:)?t\b(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
      .map((match) => decodeXml(match[1]))
      .join("");
    let value: FormulaResult = raw;
    if (type === "s") value = sharedStrings[Number(raw)] ?? "";
    else if (type === "b") value = raw === "1" || raw.toLowerCase() === "true";
    else if (type === "e") value = new FormulaError(raw || "#VALUE!");
    else if (type === "inlineStr" || inline) value = inline;
    else if (raw && !formula) {
      const numeric = Number(raw);
      value = Number.isFinite(numeric) && raw.trim() !== "" ? numeric : raw;
    } else if (raw) {
      const numeric = Number(raw);
      value = Number.isFinite(numeric) ? numeric : raw;
    } else {
      value = formula ? null : "";
    }
    setCell(sheet, row, col, {
      value,
      formula: formula || undefined,
      type: type === "inlineStr" ? "s" : type as SheetCell["type"],
      style: Number.isFinite(style) ? style : undefined,
      originalXml: token,
    });
  }
  parseSheetLayout(sheet, xml);
  return sheet;
}

function parseSheetLayout(sheet: SheetModel, xml: string) {
  const merges: SheetMerge[] = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?mergeCell\b[^>]*>/g)) {
    const ref = xmlAttr(match[0], "ref");
    if (!ref.includes(":")) continue;
    const [startRaw, endRaw] = ref.split(":");
    const start = parseCellAddress(startRaw);
    const end = parseCellAddress(endRaw);
    merges.push({ r: start.row, c: start.col, rows: end.row - start.row + 1, cols: end.col - start.col + 1 });
  }
  if (merges.length) sheet.merges = merges;
  const pane = /<(?:[\w.-]+:)?pane\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (pane && (xmlAttr(pane, "state") === "frozen" || xmlAttr(pane, "state") === "frozenSplit")) {
    sheet.freeze = { row: Number(xmlAttr(pane, "ySplit")) || 0, col: Number(xmlAttr(pane, "xSplit")) || 0 };
  }
  const filterRef = xmlAttr(/<(?:[\w.-]+:)?autoFilter\b[^>]*>/.exec(xml)?.[0] ?? "", "ref");
  if (filterRef.includes(":")) {
    const [startRaw, endRaw] = filterRef.split(":");
    const start = parseCellAddress(startRaw);
    const end = parseCellAddress(endRaw);
    sheet.filter = { r: start.row, c: start.col, rows: end.row - start.row + 1, cols: end.col - start.col + 1 };
  }
  const widths = new Map<number, number>();
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?col\b[^>]*>/g)) {
    const min = Number(xmlAttr(match[0], "min") || "1") - 1;
    const max = Number(xmlAttr(match[0], "max") || String(min + 1)) - 1;
    const width = Number(xmlAttr(match[0], "width"));
    if (!Number.isFinite(width)) continue;
    for (let col = min; col <= max; col += 1) widths.set(col, width);
  }
  if (widths.size) sheet.colWidths = widths;
}

function openCsv(buffer: ArrayBuffer): WorkbookModel {
  const text = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  const sheet: SheetModel = { name: "Sheet1", rows: rows.length, cols: 0, cells: cellMap(), path: "xl/worksheets/sheet1.xml" };
  rows.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value === "") return;
      const numeric = Number(value);
      setCell(sheet, rowIndex, colIndex, {
        value: value !== "" && Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(value) ? numeric : value,
        type: /^-?\d+(\.\d+)?$/.test(value) ? "n" : "s",
        dirty: true,
      });
    });
  });
  return { type: "spreadsheet", format: "csv", sheets: [sheet], sharedStrings: [], editable: true };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "," || char === "\t") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function openViaSheetJs(buffer: ArrayBuffer, format: string): WorkbookModel {
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: false,
    cellStyles: false,
    cellHTML: false,
    cellFormula: true,
    bookVBA: false,
    dense: true,
  });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const model: SheetModel = { name, rows: 0, cols: 0, cells: cellMap(), path: `xl/worksheets/${name}.xml` };
    const dense = (sheet as XLSX.WorkSheet & { "!data"?: Array<Array<XLSX.CellObject | undefined>> })["!data"]
      ?? (Array.isArray(sheet) ? sheet as unknown as Array<Array<XLSX.CellObject | undefined>> : null);
    if (sheet?.["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      model.rows = range.e.r + 1;
      model.cols = range.e.c + 1;
    }
    if (dense) {
      dense.forEach((line, row) => {
        line?.forEach((cell, col) => {
          if (!cell) return;
          const formula = cell.f ? String(cell.f) : undefined;
          setCell(model, row, col, {
            value: cell.v as FormulaResult,
            formula,
            type: cell.t === "s" || (cell.t as string) === "str" ? "s" : cell.t === "b" ? "b" : cell.t === "e" ? "e" : "n",
            dirty: true,
          });
        });
      });
    }
    return model;
  });
  const model: WorkbookModel = {
    type: "spreadsheet",
    format,
    sheets,
    sharedStrings: [],
    editable: true,
    viaSheetJs: true,
  };
  recalcWorkbook(model);
  return model;
}

export function sheetLookup(workbook: WorkbookModel, sheet: SheetModel, compute: (sheet: SheetModel, row: number, col: number) => FormulaResult): SheetLookup {
  return {
    getCell(row, col) {
      return compute(sheet, row, col);
    },
    getSheet(name) {
      const target = workbook.sheets.find((item) => item.name === name);
      return target ? sheetLookup(workbook, target, compute) : undefined;
    },
  };
}

export function recalcWorkbook(workbook: WorkbookModel) {
  const cache = new Map<string, FormulaResult>();
  const visiting = new Set<string>();
  const compute = (sheet: SheetModel, row: number, col: number): FormulaResult => {
    const key = `${sheet.name}:${row}:${col}`;
    if (cache.has(key)) return cache.get(key) as FormulaResult;
    const cell = getCell(sheet, row, col);
    if (!cell) return null;
    if (!cell.formula) {
      cache.set(key, cell.value);
      return cell.value;
    }
    if (visiting.has(key)) {
      const error = new FormulaError("#CYCLE!");
      cell.value = error;
      cache.set(key, error);
      return error;
    }
    visiting.add(key);
    const value = evaluateFormula(cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`, sheetLookup(workbook, sheet, compute), visiting);
    visiting.delete(key);
    cell.value = value;
    cache.set(key, value);
    return value;
  };
  for (const sheet of workbook.sheets) {
    for (const [row, line] of sheet.cells) {
      for (const col of line.keys()) compute(sheet, row, col);
    }
  }
}

export function editCell(workbook: WorkbookModel, sheetName: string, row: number, col: number, input: string) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  const trimmed = input.replace(/^\s+/, "");
  if (trimmed === "") {
    sheet.cells.get(row)?.delete(col);
    if (sheet.cells.get(row)?.size === 0) sheet.cells.delete(row);
    recalcWorkbook(workbook);
    return;
  }
  const cell = getCell(sheet, row, col) ?? { value: "", dirty: true };
  cell.dirty = true;
  cell.originalXml = undefined;
  if (trimmed.startsWith("=")) {
    cell.formula = trimmed.slice(1);
    cell.type = "n";
  } else if (/^(true|false)$/i.test(trimmed)) {
    cell.formula = undefined;
    cell.value = trimmed.toLowerCase() === "true";
    cell.type = "b";
  } else if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
    cell.formula = undefined;
    cell.value = Number(trimmed.slice(0, -1)) / 100;
    cell.type = "n";
    cell.format = { ...cell.format, numFmt: "percent" };
  } else if (/^[¥$€]\s*-?\d+(\.\d+)?$/.test(trimmed) || /^-?\d+(\.\d+)?\s*元$/.test(trimmed)) {
    cell.formula = undefined;
    cell.value = Number(trimmed.replace(/[¥$€元\s]/g, ""));
    cell.type = "n";
    cell.format = { ...cell.format, numFmt: "currency", decimals: 2 };
  } else if (/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.test(trimmed)) {
    const [, y, m, d] = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed)!;
    cell.formula = undefined;
    cell.value = excelSerialFromYmd(Number(y), Number(m), Number(d));
    cell.type = "n";
    cell.format = { ...cell.format, numFmt: "date" };
  } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    cell.formula = undefined;
    cell.value = Number(trimmed);
    cell.type = "n";
  } else {
    cell.formula = undefined;
    cell.value = trimmed;
    cell.type = "s";
  }
  setCell(sheet, row, col, cell);
  recalcWorkbook(workbook);
}

export function readViewport(workbook: WorkbookModel, sheetName: string, rowStart: number, rowCount: number, colStart: number, colCount: number): SheetViewport {
  const sheet = workbook.sheets.find((item) => item.name === sheetName) ?? workbook.sheets[0];
  if (!sheet) return { name: sheetName, rows: 0, cols: 0, rowStart, colStart, cells: [] };
  const cells: ViewportCell[] = [];
  const rowEnd = rowStart + rowCount;
  const colEnd = colStart + colCount;
  for (const [row, line] of sheet.cells) {
    if (row < rowStart || row >= rowEnd) continue;
    for (const [col, cell] of line) {
      if (col < colStart || col >= colEnd) continue;
      cells.push({
        r: row,
        c: col,
        display: formatCellDisplay(cell),
        formula: cell.formula ? `=${cell.formula}` : getCellInput(sheet, row, col),
        type: cell.formula ? "f" : cell.type ?? (typeof cell.value === "number" ? "n" : "s"),
        align: cell.format?.align,
        bold: cell.format?.bold,
        wrap: cell.format?.wrap,
        color: cell.format?.color,
        fill: cell.format?.fill,
        merge: sheet.merges?.find((item) => item.r === row && item.c === col),
      });
    }
  }
  return { name: sheet.name, rows: sheet.rows, cols: sheet.cols, rowStart, colStart, cells, freeze: sheet.freeze, merges: sheet.merges };
}

export function formatCellDisplay(cell: SheetCell) {
  const value = cell.value;
  const fmt = cell.format?.numFmt ?? "general";
  const decimals = cell.format?.decimals ?? (fmt === "currency" || fmt === "number" ? 2 : fmt === "percent" ? 2 : 0);
  if (value instanceof FormulaError) return value.token;
  if (fmt === "percent" && typeof value === "number") return `${(value * 100).toFixed(decimals)}%`;
  if (fmt === "currency" && typeof value === "number") return `¥${value.toFixed(decimals)}`;
  if (fmt === "date" && typeof value === "number") {
    const { y, m, d } = ymdFromExcelSerial(value);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  if (fmt === "scientific" && typeof value === "number") return value.toExponential(decimals || 2);
  if (fmt === "number" && typeof value === "number") return value.toFixed(decimals);
  if (fmt === "text") return displayFormulaValue(value);
  return displayFormulaValue(value);
}

export function serializeWorkbook(workbook: WorkbookModel): Uint8Array {
  if (workbook.format === "csv") return new TextEncoder().encode(serializeCsv(workbook.sheets[0]));
  if (workbook.viaSheetJs) return serializeViaSheetJs(workbook);
  return serializeXlsx(workbook);
}

function serializeCsv(sheet: SheetModel | undefined) {
  if (!sheet) return "";
  const lines: string[] = [];
  for (let row = 0; row < sheet.rows; row += 1) {
    const values: string[] = [];
    for (let col = 0; col < sheet.cols; col += 1) {
      const cell = getCell(sheet, row, col);
      const text = cell?.formula ? `=${cell.formula}` : displayFormulaValue(cell?.value ?? "");
      values.push(/[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text);
    }
    while (values.length && values[values.length - 1] === "") values.pop();
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

function serializeViaSheetJs(workbook: WorkbookModel) {
  const book = XLSX.utils.book_new();
  for (const sheet of workbook.sheets) {
    const aoa: Array<Array<string | number | boolean>> = [];
    for (let row = 0; row < Math.max(sheet.rows, 1); row += 1) {
      const line: Array<string | number | boolean> = [];
      for (let col = 0; col < Math.max(sheet.cols, 1); col += 1) {
        const cell = getCell(sheet, row, col);
        if (!cell) {
          line.push("");
          continue;
        }
        if (cell.formula) line.push(`=${cell.formula}`);
        else if (typeof cell.value === "number" || typeof cell.value === "boolean") line.push(cell.value);
        else line.push(displayFormulaValue(cell.value));
      }
      aoa.push(line);
    }
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), sheet.name.slice(0, 31) || "Sheet1");
  }
  const bookType = workbook.format === "xls" ? "xls" : workbook.format === "ods" ? "ods" : "xlsx";
  return new Uint8Array(XLSX.write(book, { type: "array", bookType, cellDates: false }) as ArrayBuffer);
}

function parseStyles(xml: string): CellFormat[] {
  if (!xml) return [];
  const codes = new Map<number, string>();
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?numFmt\b[^>]*>/g)) {
    codes.set(Number(xmlAttr(match[0], "numFmtId")), xmlAttr(match[0], "formatCode"));
  }
  const fonts = [...xml.matchAll(/<(?:[\w.-]+:)?font\b[\s\S]*?<\/(?:[\w.-]+:)?font>/g)].map((match) => {
    const color = xmlAttr(/<(?:[\w.-]+:)?color\b[^>]*>/.exec(match[0])?.[0] ?? "", "rgb");
    return {
      bold: /<(?:[\w.-]+:)?b\b/.test(match[0]) || undefined,
      italic: /<(?:[\w.-]+:)?i\b/.test(match[0]) || undefined,
      underline: /<(?:[\w.-]+:)?u\b/.test(match[0]) || undefined,
      color: color ? `#${color.replace(/^FF/i, "")}` : undefined,
    };
  });
  const fills = [...xml.matchAll(/<(?:[\w.-]+:)?fill\b[\s\S]*?<\/(?:[\w.-]+:)?fill>/g)].map((match) => {
    const rgb = xmlAttr(/<(?:[\w.-]+:)?fgColor\b[^>]*>/.exec(match[0])?.[0] ?? "", "rgb");
    return rgb ? `#${rgb.replace(/^FF/i, "")}` : undefined;
  });
  const block = /<(?:[\w.-]+:)?cellXfs\b[\s\S]*?<\/(?:[\w.-]+:)?cellXfs>/.exec(xml)?.[0] ?? "";
  return [...block.matchAll(/<(?:[\w.-]+:)?xf\b[\s\S]*?(?:\/>|<\/(?:[\w.-]+:)?xf>)/g)].map((match) => {
    const numFmtId = Number(xmlAttr(match[0], "numFmtId"));
    const font = fonts[Number(xmlAttr(match[0], "fontId"))] ?? {};
    const fill = fills[Number(xmlAttr(match[0], "fillId"))];
    const alignTag = /<(?:[\w.-]+:)?alignment\b[^>]*>/.exec(match[0])?.[0] ?? "";
    const align = xmlAttr(alignTag, "horizontal");
    const wrap = xmlAttr(alignTag, "wrapText");
    const format: CellFormat = { ...font, fill };
    const numFmt = numFmtFromId(numFmtId, codes.get(numFmtId) ?? "");
    if (numFmt) format.numFmt = numFmt;
    if (align === "left" || align === "center" || align === "right") format.align = align;
    if (wrap === "1" || wrap === "true") format.wrap = true;
    return format;
  });
}

function numFmtFromId(id: number, code: string): SheetNumFmt | undefined {
  if (id === 9 || id === 10 || /%/.test(code)) return "percent";
  if (id === 14 || id === 15 || id === 16 || id === 17 || /[yY年]/.test(code) || /m{2,}.*d/i.test(code)) return "date";
  if (id === 11 || /E[+-]/i.test(code)) return "scientific";
  if (id === 49 || code === "@") return "text";
  if (id === 5 || id === 7 || id === 8 || /[¥$€]/.test(code)) return "currency";
  if (id === 2 || id === 4 || /0\.00/.test(code)) return "number";
  return id ? "number" : undefined;
}

function numFmtIdFor(format: CellFormat) {
  switch (format.numFmt) {
    case "number": return 2;
    case "percent": return 10;
    case "date": return 14;
    case "scientific": return 11;
    case "text": return 49;
    case "currency": return 7;
    default: return 0;
  }
}

function applyParsedStyles(sheets: SheetModel[], styles: CellFormat[]) {
  if (!styles.length) return;
  for (const sheet of sheets) {
    for (const line of sheet.cells.values()) {
      for (const cell of line.values()) {
        if (cell.style == null || !styles[cell.style]) continue;
        cell.format = { ...styles[cell.style], ...cell.format };
      }
    }
  }
}

function xfXml(format: CellFormat, fontId: number, fillId: number) {
  const align = format.align || format.wrap
    ? `<alignment${format.align ? ` horizontal="${format.align}"` : ""}${format.wrap ? " wrapText=\"1\"" : ""}/>`
    : "";
  return `<xf numFmtId="${numFmtIdFor(format)}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyNumberFormat="${format.numFmt && format.numFmt !== "general" ? 1 : 0}" applyFont="${fontId ? 1 : 0}" applyFill="${fillId > 1 ? 1 : 0}" applyAlignment="${align ? 1 : 0}">${align}</xf>`;
}

function writeStylesXml(files: OfficePackage, extras: CellFormat[], existingCount: number) {
  if (!extras.length) return;
  const existing = packageText(files, "xl/styles.xml", false);
  const fonts: string[] = [];
  const fills: string[] = [];
  const xfs = extras.map((format) => {
    let fontId = 0;
    if (format.bold || format.italic || format.underline || format.color) {
      fontId = fonts.length + 1;
      const rgb = format.color?.replace(/^#/, "") ?? "";
      fonts.push(`<font>${format.bold ? "<b/>" : ""}${format.italic ? "<i/>" : ""}${format.underline ? "<u/>" : ""}<sz val="11"/>${rgb ? `<color rgb="${rgb.length === 6 ? `FF${rgb}` : rgb}"/>` : ""}<name val="Calibri"/></font>`);
    }
    let fillId = 0;
    if (format.fill) {
      fillId = fills.length + 2;
      const rgb = format.fill.replace(/^#/, "");
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${rgb.length === 6 ? `FF${rgb}` : rgb}"/></patternFill></fill>`);
    }
    return xfXml(format, fontId, fillId);
  });
  if (existing && /<(?:[\w.-]+:)?cellXfs\b/.test(existing)) {
    const next = existing.replace(
      /<(?:[\w.-]+:)?cellXfs\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?cellXfs>/,
      (block) => block.replace(/count="\d+"/, `count="${existingCount + extras.length}"`).replace(/<\/(?:[\w.-]+:)?cellXfs>/, `${xfs.join("")}</cellXfs>`),
    );
    setPackageText(files, "xl/styles.xml", next);
    return;
  }
  setPackageText(files, "xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length + 1}"><font><sz val="11"/><name val="Calibri"/></font>${fonts.join("")}</fonts><fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills.join("")}</fills><borders count="1"><border/></borders><cellXfs count="${existingCount + extras.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xfs.join("")}</cellXfs></styleSheet>`);
}

function ensureStylesPart(files: OfficePackage) {
  const types = packageText(files, "[Content_Types].xml", false);
  if (types && !types.includes("/xl/styles.xml") && packageText(files, "xl/styles.xml", false)) {
    setPackageText(files, "[Content_Types].xml", types.replace("</Types>", `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`));
  }
  const rels = packageText(files, "xl/_rels/workbook.xml.rels", false);
  if (rels && !rels.includes("styles.xml") && packageText(files, "xl/styles.xml", false)) {
    setPackageText(files, "xl/_rels/workbook.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
  }
}

function serializeXlsx(workbook: WorkbookModel) {
  const files = workbook.files ? clonePackage(workbook.files) : minimalXlsx(workbook);
  const strings: string[] = [...workbook.sharedStrings];
  const intern = (value: string) => {
    const index = strings.indexOf(value);
    if (index >= 0) return index;
    strings.push(value);
    return strings.length - 1;
  };
  const existingStyles = parseStyles(packageText(files, "xl/styles.xml", false));
  const existingCount = Math.max(1, existingStyles.length);
  const extras: CellFormat[] = [];
  const extraIndex = new Map<string, number>();
  const styleOf = (cell: SheetCell) => {
    if (!cell.format || !cell.dirty) return cell.style;
    const key = JSON.stringify(cell.format);
    const hit = extraIndex.get(key);
    if (hit != null) return hit;
    const id = existingCount + extras.length;
    extras.push(cell.format);
    extraIndex.set(key, id);
    cell.style = id;
    return id;
  };
  for (const sheet of workbook.sheets) {
    setPackageText(files, sheet.path, serializeSheetXml(sheet, intern, styleOf));
  }
  writeStylesXml(files, extras, existingCount);
  setPackageText(files, "xl/sharedStrings.xml", serializeSharedStrings(strings));
  ensureWorkbookParts(files, workbook);
  ensureSharedStringsContentType(files);
  ensureStylesPart(files);
  workbook.sharedStrings = strings;
  return zipPackage(files);
}

function ensureWorkbookParts(files: OfficePackage, workbook: WorkbookModel) {
  workbook.sheets.forEach((sheet, index) => {
    if (!sheet.path) sheet.path = `xl/worksheets/sheet${index + 1}.xml`;
  });
  const sheetTags = workbook.sheets.map((sheet, index) => `<sheet name="${encodeXml(sheet.name)}" sheetId="${index + 1}" r:id="rIdSheet${index + 1}"/>`).join("");
  const current = packageText(files, "xl/workbook.xml", false);
  if (current && /<(?:[\w.-]+:)?sheets\b[\s\S]*?<\/(?:[\w.-]+:)?sheets>/.test(current)) {
    setPackageText(files, "xl/workbook.xml", current.replace(/<(?:[\w.-]+:)?sheets\b[\s\S]*?<\/(?:[\w.-]+:)?sheets>/, `<sheets>${sheetTags}</sheets>`));
  } else {
    setPackageText(files, "xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`);
  }
  const rels = packageText(files, "xl/_rels/workbook.xml.rels", false)
    || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const others = [...rels.matchAll(/<(?:Relationship)\b[^>]*\/>/g)]
    .map((match) => match[0])
    .filter((tag) => !/relationships\/worksheet/.test(tag) && !/sharedStrings/.test(tag));
  const sheetRels = workbook.sheets.map((sheet, index) => `<Relationship Id="rIdSheet${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.path.replace(/^xl\//, "")}"/>`).join("");
  const shared = `<Relationship Id="rIdSs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`;
  setPackageText(files, "xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${shared}${others.join("")}</Relationships>`);
  let types = packageText(files, "[Content_Types].xml", false)
    || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  types = types.replace(/<Override PartName="\/xl\/worksheets\/[^"]+"[^/]*\/>/g, "");
  const sheetTypes = workbook.sheets.map((sheet) => `<Override PartName="/${sheet.path.replace(/^\//, "")}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  setPackageText(files, "[Content_Types].xml", types.replace("</Types>", `${sheetTypes}</Types>`));
}

function serializeSheetXml(sheet: SheetModel, intern: (value: string) => number, styleOf?: (cell: SheetCell) => number | undefined) {
  const last = formatCellRef(Math.max(0, sheet.rows - 1), Math.max(0, sheet.cols - 1));
  const rows: string[] = [];
  const orderedRows = [...sheet.cells.keys()].sort((a, b) => a - b);
  for (const row of orderedRows) {
    const line = sheet.cells.get(row);
    if (!line?.size) continue;
    const cells = [...line.entries()].sort((a, b) => a[0] - b[0]).map(([col, cell]) => serializeCell(row, col, cell, intern, styleOf)).join("");
    rows.push(`<row r="${row + 1}">${cells}</row>`);
  }
  if (sheet.originalXml && !orderedRows.some((row) => [...(sheet.cells.get(row)?.values() ?? [])].some((cell) => cell.dirty))) {
    return sheet.originalXml;
  }
  if (sheet.originalXml) {
    let replaced = sheet.originalXml.replace(/<(?:[\w.-]+:)?sheetData\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?sheetData>/, `<sheetData>${rows.join("")}</sheetData>`);
    replaced = replaced.replace(/<(?:[\w.-]+:)?dimension\b[^>]*\/?>/, `<dimension ref="A1:${last}"/>`);
    replaced = injectSheetExtras(replaced, sheet);
    if (replaced !== sheet.originalXml) return replaced;
  }
  return injectSheetExtras(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetData>${rows.join("")}</sheetData></worksheet>`, sheet);
}

function injectSheetExtras(xml: string, sheet: SheetModel) {
  const cols = [...(sheet.colWidths ?? new Map()).entries()].sort((a, b) => a[0] - b[0]);
  const colXml = cols.length ? `<cols>${cols.map(([col, width]) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>` : "";
  const merges = sheet.merges ?? [];
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((item) => `<mergeCell ref="${formatCellRef(item.r, item.c)}:${formatCellRef(item.r + item.rows - 1, item.c + item.cols - 1)}"/>`).join("")}</mergeCells>`
    : "";
  const freeze = sheet.freeze;
  const viewXml = freeze && (freeze.row || freeze.col)
    ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${freeze.col}" ySplit="${freeze.row}" topLeftCell="${formatCellRef(freeze.row, freeze.col)}" state="frozen"/></sheetView></sheetViews>`
    : "";
  const filter = sheet.filter
    ? `<autoFilter ref="${formatCellRef(sheet.filter.r, sheet.filter.c)}:${formatCellRef(sheet.filter.r + sheet.filter.rows - 1, sheet.filter.c + sheet.filter.cols - 1)}"/>`
    : "";
  let next = xml;
  if (viewXml && !next.includes("<sheetViews")) next = next.replace(/<sheetData/, `${viewXml}<sheetData`);
  if (colXml && !next.includes("<cols")) next = next.replace(/<sheetData/, `${colXml}<sheetData`);
  if (mergeXml) {
    next = next.replace(/<(?:[\w.-]+:)?mergeCells\b[\s\S]*?<\/(?:[\w.-]+:)?mergeCells>/, "");
    next = next.replace("</worksheet>", `${mergeXml}</worksheet>`);
  }
  if (filter && !next.includes("autoFilter")) next = next.replace("</worksheet>", `${filter}</worksheet>`);
  return next;
}

function serializeCell(row: number, col: number, cell: SheetCell, intern: (value: string) => number, styleOf?: (cell: SheetCell) => number | undefined) {
  if (!cell.dirty && cell.originalXml) return cell.originalXml;
  const address = formatCellRef(row, col);
  const styleIndex = styleOf?.(cell) ?? cell.style;
  const style = styleIndex != null ? ` s="${styleIndex}"` : "";
  if (cell.formula) {
    const value = cell.value instanceof FormulaError ? cell.value.token : cell.value;
    const numeric = typeof value === "number";
    const body = `<f>${encodeXml(cell.formula)}</f>${value == null || value === "" ? "" : `<v>${encodeXml(String(numeric ? value : value === true ? 1 : value === false ? 0 : value))}</v>`}`;
    const type = cell.value instanceof FormulaError ? ` t="e"` : typeof value === "string" ? ` t="str"` : "";
    return `<c r="${address}"${style}${type}>${body}</c>`;
  }
  if (typeof cell.value === "boolean") return `<c r="${address}"${style} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
  if (typeof cell.value === "number") return `<c r="${address}"${style}><v>${cell.value}</v></c>`;
  if (cell.value instanceof FormulaError) return `<c r="${address}"${style} t="e"><v>${encodeXml(cell.value.token)}</v></c>`;
  const text = displayFormulaValue(cell.value);
  return `<c r="${address}"${style} t="s"><v>${intern(text)}</v></c>`;
}

function serializeSharedStrings(strings: string[]) {
  const items = strings.map((value) => `<si>${encodedTextNode("t", value)}</si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function ensureSharedStringsContentType(files: OfficePackage) {
  const current = packageText(files, "[Content_Types].xml", false);
  if (!current) return;
  if (current.includes("/xl/sharedStrings.xml")) return;
  const next = current.replace(
    "</Types>",
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  );
  setPackageText(files, "[Content_Types].xml", next);
  const rels = packageText(files, "xl/_rels/workbook.xml.rels", false);
  if (rels && !rels.includes("sharedStrings.xml")) {
    setPackageText(
      files,
      "xl/_rels/workbook.xml.rels",
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rIdSs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
      ),
    );
  }
}

function minimalXlsx(workbook: WorkbookModel): OfficePackage {
  const sheetRels = workbook.sheets.map((sheet, index) => {
    sheet.path = `xl/worksheets/sheet${index + 1}.xml`;
    return `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`;
  }).join("");
  const sheetTags = workbook.sheets.map((sheet, index) => `<sheet name="${encodeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const files: OfficePackage = {
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${workbook.sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
    "_rels/.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rIdSs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
  };
  workbook.sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = new TextEncoder().encode("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>");
  });
  return files;
}

export function getCellInput(sheet: SheetModel, row: number, col: number) {
  const cell = getCell(sheet, row, col);
  if (!cell) return "";
  if (cell.formula) return cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`;
  if (typeof cell.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  if (cell.value instanceof FormulaError) return cell.value.token;
  if (cell.format?.numFmt === "date" && typeof cell.value === "number") {
    const { y, m, d } = ymdFromExcelSerial(cell.value);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  if (cell.format?.numFmt === "percent" && typeof cell.value === "number") return `${Number((cell.value * 100).toPrecision(12))}%`;
  return displayFormulaValue(cell.value);
}

function findSheet(workbook: WorkbookModel, sheetName: string) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  return sheet;
}

function cloneCell(cell: SheetCell): SheetCell {
  return { ...cell, originalXml: undefined, dirty: true };
}

function rewriteSheetFormulas(sheet: SheetModel, rewrite: (formula: string) => string) {
  for (const line of sheet.cells.values()) {
    for (const cell of line.values()) {
      if (!cell.formula) continue;
      const next = rewrite(cell.formula);
      if (next !== cell.formula) {
        cell.formula = next.replace(/^=/, "");
        cell.dirty = true;
        cell.originalXml = undefined;
      }
    }
  }
}

export function copyRange(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number) {
  const sheet = findSheet(workbook, sheetName);
  const values: string[][] = [];
  for (let r = 0; r < Math.max(1, rowCount); r += 1) {
    const line: string[] = [];
    for (let c = 0; c < Math.max(1, colCount); c += 1) line.push(getCellInput(sheet, row + r, col + c));
    values.push(line);
  }
  return values;
}

export function pasteRange(workbook: WorkbookModel, sheetName: string, row: number, col: number, values: string[][]) {
  values.forEach((line, r) => {
    line.forEach((input, c) => editCell(workbook, sheetName, row + r, col + c, input));
  });
}

export function fillDown(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number) {
  const sheet = findSheet(workbook, sheetName);
  const height = Math.max(1, rowCount);
  const width = Math.max(1, colCount);
  for (let c = 0; c < width; c += 1) {
    const source = getCellInput(sheet, row, col + c);
    for (let r = 1; r < height; r += 1) {
      const next = source.startsWith("=") ? translateFormula(source, r, 0) : source;
      editCell(workbook, sheetName, row + r, col + c, next);
    }
  }
}

export function insertRows(workbook: WorkbookModel, sheetName: string, at: number, count = 1) {
  const sheet = findSheet(workbook, sheetName);
  const next = cellMap();
  for (const [row, line] of sheet.cells) {
    const target = row >= at ? row + count : row;
    const shifted = new Map<number, SheetCell>();
    for (const [col, cell] of line) shifted.set(col, cloneCell(cell));
    next.set(target, shifted);
  }
  sheet.cells = next;
  sheet.rows += count;
  rewriteSheetFormulas(sheet, (formula) => shiftFormula(formula, { rowAt: at, rowDelta: count }));
  recalcWorkbook(workbook);
}

export function insertCols(workbook: WorkbookModel, sheetName: string, at: number, count = 1) {
  const sheet = findSheet(workbook, sheetName);
  const next = cellMap();
  for (const [row, line] of sheet.cells) {
    const shifted = new Map<number, SheetCell>();
    for (const [col, cell] of line) shifted.set(col >= at ? col + count : col, cloneCell(cell));
    next.set(row, shifted);
  }
  sheet.cells = next;
  sheet.cols += count;
  rewriteSheetFormulas(sheet, (formula) => shiftFormula(formula, { colAt: at, colDelta: count }));
  recalcWorkbook(workbook);
}

export function deleteRows(workbook: WorkbookModel, sheetName: string, at: number, count = 1) {
  const sheet = findSheet(workbook, sheetName);
  const next = cellMap();
  for (const [row, line] of sheet.cells) {
    if (row >= at && row < at + count) continue;
    const target = row >= at + count ? row - count : row;
    const shifted = new Map<number, SheetCell>();
    for (const [col, cell] of line) shifted.set(col, cloneCell(cell));
    next.set(target, shifted);
  }
  sheet.cells = next;
  sheet.rows = Math.max(0, sheet.rows - count);
  rewriteSheetFormulas(sheet, (formula) => shiftFormula(formula, { deletedRows: { start: at, count } }));
  recalcWorkbook(workbook);
}

export function deleteCols(workbook: WorkbookModel, sheetName: string, at: number, count = 1) {
  const sheet = findSheet(workbook, sheetName);
  const next = cellMap();
  for (const [row, line] of sheet.cells) {
    const shifted = new Map<number, SheetCell>();
    for (const [col, cell] of line) {
      if (col >= at && col < at + count) continue;
      shifted.set(col >= at + count ? col - count : col, cloneCell(cell));
    }
    if (shifted.size) next.set(row, shifted);
  }
  sheet.cells = next;
  sheet.cols = Math.max(0, sheet.cols - count);
  rewriteSheetFormulas(sheet, (formula) => shiftFormula(formula, { deletedCols: { start: at, count } }));
  recalcWorkbook(workbook);
}

export function addSheet(workbook: WorkbookModel, name?: string) {
  const base = name?.trim() || "Sheet";
  let candidate = base;
  let index = 1;
  while (workbook.sheets.some((sheet) => sheet.name === candidate)) {
    index += 1;
    candidate = `${base}${index}`;
  }
  workbook.sheets.push({
    name: candidate,
    rows: 0,
    cols: 0,
    cells: cellMap(),
    path: `xl/worksheets/sheet${workbook.sheets.length + 1}.xml`,
  });
  return candidate;
}

export function fillRight(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number) {
  const sheet = findSheet(workbook, sheetName);
  const height = Math.max(1, rowCount);
  const width = Math.max(1, colCount);
  for (let r = 0; r < height; r += 1) {
    const source = getCellInput(sheet, row + r, col);
    for (let c = 1; c < width; c += 1) {
      const next = source.startsWith("=") ? translateFormula(source, 0, c) : source;
      editCell(workbook, sheetName, row + r, col + c, next);
    }
  }
}

export function mergeCells(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number, merge = true) {
  const sheet = findSheet(workbook, sheetName);
  sheet.merges = (sheet.merges ?? []).filter((item) => !(item.r === row && item.c === col));
  if (merge && (rowCount > 1 || colCount > 1)) sheet.merges.push({ r: row, c: col, rows: Math.max(1, rowCount), cols: Math.max(1, colCount) });
}

export function setCellFormat(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number, format: CellFormat) {
  const sheet = findSheet(workbook, sheetName);
  for (let r = 0; r < Math.max(1, rowCount); r += 1) {
    for (let c = 0; c < Math.max(1, colCount); c += 1) {
      const cell = getCell(sheet, row + r, col + c) ?? { value: "", dirty: true };
      cell.format = { ...cell.format, ...format };
      cell.dirty = true;
      cell.originalXml = undefined;
      setCell(sheet, row + r, col + c, cell);
    }
  }
}

export function sortRange(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number, sortCol = 0, ascending = true) {
  const values = copyRange(workbook, sheetName, row, col, rowCount, colCount);
  values.sort((a, b) => {
    const left = a[sortCol] ?? "";
    const right = b[sortCol] ?? "";
    const ln = Number(left);
    const rn = Number(right);
    const cmp = Number.isFinite(ln) && Number.isFinite(rn) && left !== "" && right !== ""
      ? ln - rn
      : String(left).localeCompare(String(right), "zh");
    return ascending ? cmp : -cmp;
  });
  pasteRange(workbook, sheetName, row, col, values);
}

export function freezePanes(workbook: WorkbookModel, sheetName: string, row: number, col: number) {
  findSheet(workbook, sheetName).freeze = { row, col };
}

export function setAutoFilter(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number) {
  const sheet = findSheet(workbook, sheetName);
  const next = { r: row, c: col, rows: Math.max(1, rowCount), cols: Math.max(1, colCount) };
  if (sheet.filter && sheet.filter.r === next.r && sheet.filter.c === next.c && sheet.filter.rows === next.rows && sheet.filter.cols === next.cols) {
    sheet.filter = undefined;
    return;
  }
  sheet.filter = next;
}

export function setColumnWidth(workbook: WorkbookModel, sheetName: string, col: number, width: number) {
  const sheet = findSheet(workbook, sheetName);
  sheet.colWidths ??= new Map();
  sheet.colWidths.set(col, width);
}

export function renameSheet(workbook: WorkbookModel, name: string, next: string) {
  const sheet = findSheet(workbook, name);
  const candidate = next.trim().slice(0, 31);
  if (!candidate || workbook.sheets.some((item) => item.name === candidate && item !== sheet)) throw new Error("工作表名称无效或已存在");
  sheet.name = candidate;
  return candidate;
}

export function removeSheet(workbook: WorkbookModel, name: string) {
  if (workbook.sheets.length <= 1) throw new Error("至少保留一张工作表");
  const index = workbook.sheets.findIndex((sheet) => sheet.name === name);
  if (index < 0) throw new Error(`找不到工作表：${name}`);
  return workbook.sheets.splice(index, 1)[0];
}

export function autoSum(workbook: WorkbookModel, sheetName: string, row: number, col: number, rowCount: number, colCount: number) {
  const sheet = findSheet(workbook, sheetName);
  if (rowCount > 1 && colCount === 1) {
    const start = formatCellRef(row, col);
    const end = formatCellRef(row + rowCount - 2, col);
    editCell(workbook, sheetName, row + rowCount - 1, col, `=SUM(${start}:${end})`);
    return;
  }
  if (colCount > 1) {
    const start = formatCellRef(row, col);
    const end = formatCellRef(row, col + colCount - 2);
    editCell(workbook, sheetName, row, col + colCount - 1, `=SUM(${start}:${end})`);
    return;
  }
  let last = row - 1;
  while (last >= 0 && typeof getCell(sheet, last, col)?.value === "number") last -= 1;
  last += 1;
  if (last < row) editCell(workbook, sheetName, row, col, `=SUM(${formatCellRef(last, col)}:${formatCellRef(row - 1, col)})`);
}
