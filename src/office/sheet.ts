import * as XLSX from "@e965/xlsx";
import { displayFormulaValue, evaluateFormula, formatCellRef, FormulaError, shiftFormula, translateFormula, type FormulaResult, type SheetLookup } from "./formula";
import { clonePackage, findPackagePart, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";
import { decodeXml, encodedTextNode, encodeXml, xmlAttr } from "./xml";

export interface SheetCell {
  value: FormulaResult;
  formula?: string;
  type?: "n" | "s" | "b" | "e" | "str";
  style?: number;
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
}

export interface SheetViewport {
  name: string;
  rows: number;
  cols: number;
  rowStart: number;
  colStart: number;
  cells: ViewportCell[];
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
  return sheet;
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
        display: displayFormulaValue(cell.value),
        formula: cell.formula ? `=${cell.formula}` : displayFormulaValue(cell.value),
        type: cell.formula ? "f" : cell.type ?? (typeof cell.value === "number" ? "n" : "s"),
      });
    }
  }
  return { name: sheet.name, rows: sheet.rows, cols: sheet.cols, rowStart, colStart, cells };
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

function serializeXlsx(workbook: WorkbookModel) {
  const files = workbook.files ? clonePackage(workbook.files) : minimalXlsx(workbook);
  const strings: string[] = [...workbook.sharedStrings];
  const intern = (value: string) => {
    const index = strings.indexOf(value);
    if (index >= 0) return index;
    strings.push(value);
    return strings.length - 1;
  };
  for (const sheet of workbook.sheets) {
    setPackageText(files, sheet.path, serializeSheetXml(sheet, intern));
  }
  setPackageText(files, "xl/sharedStrings.xml", serializeSharedStrings(strings));
  ensureSharedStringsContentType(files);
  workbook.sharedStrings = strings;
  return zipPackage(files);
}

function serializeSheetXml(sheet: SheetModel, intern: (value: string) => number) {
  const last = formatCellRef(Math.max(0, sheet.rows - 1), Math.max(0, sheet.cols - 1));
  const rows: string[] = [];
  const orderedRows = [...sheet.cells.keys()].sort((a, b) => a - b);
  for (const row of orderedRows) {
    const line = sheet.cells.get(row);
    if (!line?.size) continue;
    const cells = [...line.entries()].sort((a, b) => a[0] - b[0]).map(([col, cell]) => serializeCell(row, col, cell, intern)).join("");
    rows.push(`<row r="${row + 1}">${cells}</row>`);
  }
  if (sheet.originalXml && !orderedRows.some((row) => [...(sheet.cells.get(row)?.values() ?? [])].some((cell) => cell.dirty))) {
    return sheet.originalXml;
  }
  if (sheet.originalXml) {
    const replaced = sheet.originalXml.replace(/<(?:[\w.-]+:)?sheetData\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?sheetData>/, `<sheetData>${rows.join("")}</sheetData>`);
    if (replaced !== sheet.originalXml) return replaced.replace(/<(?:[\w.-]+:)?dimension\b[^>]*\/?>/, `<dimension ref="A1:${last}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function serializeCell(row: number, col: number, cell: SheetCell, intern: (value: string) => number) {
  if (!cell.dirty && cell.originalXml) return cell.originalXml;
  const address = formatCellRef(row, col);
  const style = cell.style != null ? ` s="${cell.style}"` : "";
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
