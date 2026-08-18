import { colName } from "./formula";
import type { OfficeMutation } from "./types";
import type { WordBlock, WordList, WordParagraph, WordRun } from "./word";
import type { CellFormat } from "./sheet";
import type { SlideShape } from "./slide";

export interface OfficeExcerptQuery {
  offset?: number;
  count?: number;
  sheet?: string;
  row?: number;
  col?: number;
  rowCount?: number;
  colCount?: number;
  slide?: number;
}

export interface OfficeInspectResult {
  kind: "word" | "spreadsheet" | "presentation";
  format: string;
  summary: string;
  word?: {
    totalBlocks: number;
    characters: number;
    words: number;
    paragraphs: number;
    header?: string;
    footer?: string;
    preview: string[];
  };
  spreadsheet?: {
    sheets: Array<{ name: string; rows: number; cols: number }>;
    active?: string;
  };
  presentation?: {
    slides: Array<{ index: number; title: string; hidden?: boolean; shapeCount: number }>;
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}

function asOptionalString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 必须是数字`);
  return Math.round(value);
}

function asOptionalNumber(value: unknown, label: string) {
  if (value === undefined) return undefined;
  return asNumber(value, label);
}

function asBoolean(value: unknown, fallback: boolean, label: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function asAlign(value: unknown): WordParagraph["align"] | undefined {
  if (value === undefined) return undefined;
  if (value === "left" || value === "center" || value === "right" || value === "justify") return value;
  throw new Error("align 必须是 left、center、right 或 justify");
}

function asList(value: unknown): WordList | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const list = asRecord(value, "list");
  const type = list.type;
  if (type !== "bullet" && type !== "number") throw new Error("list.type 必须是 bullet 或 number");
  return { type, level: asOptionalNumber(list.level, "list.level") ?? 0, numId: asOptionalNumber(list.numId, "list.numId") ?? (type === "bullet" ? 1 : 2) };
}

function asRunStyle(value: unknown, requireText: boolean): WordRun {
  const run = asRecord(value, "style");
  const text = requireText ? asString(run.text, "run.text") : asOptionalString(run.text, "run.text") ?? "";
  return {
    text,
    bold: typeof run.bold === "boolean" ? run.bold : undefined,
    italic: typeof run.italic === "boolean" ? run.italic : undefined,
    underline: typeof run.underline === "boolean" ? run.underline : undefined,
    strike: typeof run.strike === "boolean" ? run.strike : undefined,
    fontSize: asOptionalNumber(run.fontSize, "run.fontSize"),
    color: asOptionalString(run.color, "run.color"),
    font: asOptionalString(run.font, "run.font"),
    highlight: asOptionalString(run.highlight, "run.highlight"),
    vertAlign: run.vertAlign === "subscript" || run.vertAlign === "superscript" ? run.vertAlign : undefined,
    hyperlink: asOptionalString(run.hyperlink, "run.hyperlink"),
  };
}

function asRun(value: unknown): WordRun {
  return asRunStyle(value, true);
}

function asPartialRunStyle(value: unknown): Partial<WordRun> {
  const run = asRunStyle(value, false);
  const style: Partial<WordRun> = { ...run };
  if (!asOptionalString(asRecord(value, "style").text, "style.text")) delete style.text;
  return style;
}

function asBlock(value: unknown): WordBlock {
  const block = asRecord(value, "block");
  if (block.kind === "table") {
    if (!Array.isArray(block.rows)) throw new Error("表格 block.rows 必须是二维数组");
    return {
      kind: "table",
      dirty: true,
      rows: block.rows.map((row) => {
        if (!Array.isArray(row)) throw new Error("表格行必须是数组");
        return row.map((cell) => ({ text: asString(asRecord(cell, "cell").text, "cell.text") }));
      }),
    };
  }
  if (block.kind !== "paragraph" && block.kind !== "heading") throw new Error("block.kind 必须是 paragraph、heading 或 table");
  if (!Array.isArray(block.runs)) throw new Error("block.runs 必须是数组");
  return {
    kind: block.kind,
    dirty: true,
    level: asOptionalNumber(block.level, "block.level"),
    align: asAlign(block.align),
    indent: asOptionalNumber(block.indent, "block.indent"),
    lineSpacing: typeof block.lineSpacing === "number" ? block.lineSpacing : undefined,
    pageBreak: typeof block.pageBreak === "boolean" ? block.pageBreak : undefined,
    runs: block.runs.map(asRun),
  };
}

function asCellFormat(value: unknown): CellFormat {
  const format = asRecord(value, "format");
  const numFmt = format.numFmt;
  if (numFmt !== undefined && !["general", "number", "percent", "currency", "date", "text", "scientific"].includes(String(numFmt))) {
    throw new Error("format.numFmt 不受支持");
  }
  const align = format.align;
  if (align !== undefined && align !== "left" && align !== "center" && align !== "right") throw new Error("format.align 必须是 left、center 或 right");
  return {
    bold: typeof format.bold === "boolean" ? format.bold : undefined,
    italic: typeof format.italic === "boolean" ? format.italic : undefined,
    underline: typeof format.underline === "boolean" ? format.underline : undefined,
    wrap: typeof format.wrap === "boolean" ? format.wrap : undefined,
    color: asOptionalString(format.color, "format.color"),
    fill: asOptionalString(format.fill, "format.fill"),
    numFmt: numFmt as CellFormat["numFmt"],
    align: align as CellFormat["align"],
    decimals: asOptionalNumber(format.decimals, "format.decimals"),
  };
}

function asShapePatch(value: unknown): Partial<Pick<SlideShape, "bold" | "italic" | "fontSize" | "align" | "color" | "text" | "fill">> {
  const patch = asRecord(value, "patch");
  const align = patch.align;
  if (align !== undefined && align !== "left" && align !== "center" && align !== "right") throw new Error("shape.align 必须是 left、center 或 right");
  return {
    bold: typeof patch.bold === "boolean" ? patch.bold : undefined,
    italic: typeof patch.italic === "boolean" ? patch.italic : undefined,
    fontSize: asOptionalNumber(patch.fontSize, "patch.fontSize"),
    align: align as SlideShape["align"] | undefined,
    color: asOptionalString(patch.color, "patch.color"),
    text: asOptionalString(patch.text, "patch.text"),
    fill: asOptionalString(patch.fill, "patch.fill"),
  };
}

export function parseOfficeExcerptQuery(input: unknown): OfficeExcerptQuery {
  if (input === undefined || input === null) return {};
  const value = asRecord(input, "query");
  return {
    offset: asOptionalNumber(value.offset, "offset"),
    count: asOptionalNumber(value.count, "count"),
    sheet: asOptionalString(value.sheet, "sheet"),
    row: asOptionalNumber(value.row, "row"),
    col: asOptionalNumber(value.col, "col"),
    rowCount: asOptionalNumber(value.rowCount, "rowCount") ?? asOptionalNumber(value.row_count, "row_count"),
    colCount: asOptionalNumber(value.colCount, "colCount") ?? asOptionalNumber(value.col_count, "col_count"),
    slide: asOptionalNumber(value.slide, "slide") ?? asOptionalNumber(value.index, "index"),
  };
}

export function parseOfficeMutation(input: unknown): OfficeMutation {
  if (typeof input === "string") {
    try { input = JSON.parse(input) as unknown; }
    catch { throw new Error("mutation 必须是对象"); }
  }
  const value = asRecord(input, "mutation");
  const op = asString(value.op, "op");
  switch (op) {
    case "wordReplace":
      return { op, index: asNumber(value.index, "index"), block: asBlock(value.block) };
    case "wordInsert":
      return { op, index: asNumber(value.index, "index"), block: asBlock(value.block) };
    case "wordDelete":
      return { op, index: asNumber(value.index, "index") };
    case "wordSplit":
      return { op, index: asNumber(value.index, "index"), offset: asNumber(value.offset, "offset") };
    case "wordStyle": {
      const patchIn = asRecord(value.patch, "patch");
      const kind = patchIn.kind;
      if (kind !== undefined && kind !== "paragraph" && kind !== "heading") throw new Error("patch.kind 必须是 paragraph 或 heading");
      return {
        op,
        index: asNumber(value.index, "index"),
        patch: {
          kind,
          level: asOptionalNumber(patchIn.level, "patch.level"),
          align: asAlign(patchIn.align),
          style: asOptionalString(patchIn.style, "patch.style"),
          indent: asOptionalNumber(patchIn.indent, "patch.indent"),
          lineSpacing: typeof patchIn.lineSpacing === "number" ? patchIn.lineSpacing : undefined,
          pageBreak: typeof patchIn.pageBreak === "boolean" ? patchIn.pageBreak : undefined,
          spacingBefore: asOptionalNumber(patchIn.spacingBefore, "patch.spacingBefore"),
          spacingAfter: asOptionalNumber(patchIn.spacingAfter, "patch.spacingAfter"),
          list: asList(patchIn.list),
        },
      };
    }
    case "wordRunStyle":
      return { op, index: asNumber(value.index, "index"), style: asPartialRunStyle(value.style) };
    case "wordFindReplace":
      return { op, query: asString(value.query, "query"), replacement: asString(value.replacement, "replacement"), all: asBoolean(value.all, true, "all") };
    case "wordTable": {
      const action = value.action;
      if (action !== "insert" && action !== "insertRow" && action !== "insertCol" && action !== "deleteRow" && action !== "deleteCol" && action !== "setCell") {
        throw new Error("wordTable.action 不受支持");
      }
      return {
        op,
        action,
        index: asNumber(value.index, "index"),
        row: asOptionalNumber(value.row, "row"),
        col: asOptionalNumber(value.col, "col"),
        rows: asOptionalNumber(value.rows, "rows"),
        cols: asOptionalNumber(value.cols, "cols"),
        text: asOptionalString(value.text, "text"),
      };
    }
    case "wordHeaderFooter":
      return { op, header: asOptionalString(value.header, "header"), footer: asOptionalString(value.footer, "footer") };
    case "sheetEdit":
      return { op, name: asString(value.name, "name"), row: asNumber(value.row, "row"), col: asNumber(value.col, "col"), input: asString(value.input, "input") };
    case "sheetAdd":
      return { op, name: asOptionalString(value.name, "name") };
    case "sheetInsert":
    case "sheetDelete": {
      const axis = value.axis;
      if (axis !== "row" && axis !== "col") throw new Error("axis 必须是 row 或 col");
      return { op, name: asString(value.name, "name"), axis, index: asNumber(value.index, "index"), count: asOptionalNumber(value.count, "count") };
    }
    case "sheetFill":
    case "sheetFillRight":
    case "sheetAutoSum":
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        rowCount: asNumber(value.rowCount ?? value.row_count, "rowCount"),
        colCount: asNumber(value.colCount ?? value.col_count, "colCount"),
      };
    case "sheetPaste": {
      if (!Array.isArray(value.values)) throw new Error("values 必须是二维字符串数组");
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        values: value.values.map((row) => {
          if (!Array.isArray(row)) throw new Error("values 的每一行必须是数组");
          return row.map((cell) => String(cell ?? ""));
        }),
      };
    }
    case "sheetFormat":
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        rowCount: asNumber(value.rowCount ?? value.row_count, "rowCount"),
        colCount: asNumber(value.colCount ?? value.col_count, "colCount"),
        format: asCellFormat(value.format),
      };
    case "sheetMerge":
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        rowCount: asNumber(value.rowCount ?? value.row_count, "rowCount"),
        colCount: asNumber(value.colCount ?? value.col_count, "colCount"),
        merge: asBoolean(value.merge, true, "merge"),
      };
    case "sheetSort":
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        rowCount: asNumber(value.rowCount ?? value.row_count, "rowCount"),
        colCount: asNumber(value.colCount ?? value.col_count, "colCount"),
        sortCol: asOptionalNumber(value.sortCol ?? value.sort_col, "sortCol"),
        ascending: asBoolean(value.ascending, true, "ascending"),
      };
    case "sheetFreeze":
      return { op, name: asString(value.name, "name"), row: asNumber(value.row, "row"), col: asNumber(value.col, "col") };
    case "sheetFilter":
      return {
        op,
        name: asString(value.name, "name"),
        row: asNumber(value.row, "row"),
        col: asNumber(value.col, "col"),
        rowCount: asNumber(value.rowCount ?? value.row_count, "rowCount"),
        colCount: asNumber(value.colCount ?? value.col_count, "colCount"),
      };
    case "sheetRename":
      return { op, name: asString(value.name, "name"), next: asString(value.next, "next") };
    case "sheetRemove":
      return { op, name: asString(value.name, "name") };
    case "sheetWidth":
      return { op, name: asString(value.name ?? "", "name") || asString(value.sheet, "sheet"), col: asNumber(value.col, "col"), width: asNumber(value.width, "width") };
    case "slideText":
      return { op, index: asNumber(value.index, "index"), shapeId: asString(value.shapeId ?? value.shape_id, "shapeId"), text: asString(value.text, "text") };
    case "slideAdd":
      return { op };
    case "slideDelete":
    case "slideDuplicate":
      return { op, index: asNumber(value.index, "index") };
    case "slideBackground":
      return { op, index: asNumber(value.index, "index"), background: asString(value.background, "background") };
    case "slideShape":
      return { op, index: asNumber(value.index, "index"), shapeId: asString(value.shapeId ?? value.shape_id, "shapeId"), patch: asShapePatch(value.patch) };
    case "slideDeleteShape":
      return { op, index: asNumber(value.index, "index"), shapeId: asString(value.shapeId ?? value.shape_id, "shapeId") };
    case "slideAddTextBox":
    case "slideHide":
      if (op === "slideHide") return { op, index: asNumber(value.index, "index"), hidden: asBoolean(value.hidden, true, "hidden") };
      return { op, index: asNumber(value.index, "index") };
    case "slideMove":
      return {
        op,
        index: asNumber(value.index, "index"),
        shapeId: asString(value.shapeId ?? value.shape_id, "shapeId"),
        x: typeof value.x === "number" ? value.x : asNumber(value.x, "x"),
        y: typeof value.y === "number" ? value.y : asNumber(value.y, "y"),
        width: typeof value.width === "number" ? value.width : asOptionalNumber(value.width, "width"),
        height: typeof value.height === "number" ? value.height : asOptionalNumber(value.height, "height"),
      };
    case "slideNotes":
      return { op, index: asNumber(value.index, "index"), notes: asString(value.notes, "notes") };
    case "slideLayout": {
      const layout = value.layout;
      if (layout !== "title" && layout !== "titleContent" && layout !== "blank" && layout !== "twoContent") {
        throw new Error("layout 必须是 title、titleContent、blank 或 twoContent");
      }
      return { op, index: asNumber(value.index, "index"), layout };
    }
    case "slideReorder":
      return { op, from: asNumber(value.from, "from"), to: asNumber(value.to, "to") };
    default:
      throw new Error(`不支持的 office op：${op}`);
  }
}

export function a1Range(row: number, col: number, rowCount = 1, colCount = 1) {
  const start = `${colName(col)}${row + 1}`;
  if (rowCount <= 1 && colCount <= 1) return start;
  return `${start}:${colName(col + colCount - 1)}${row + rowCount}`;
}

export function clipAgentText(text: string, limit = 24_000) {
  return text.length > limit ? `${text.slice(0, limit)}\n…[已按 Agent 摘录上限截断]` : text;
}
