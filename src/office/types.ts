import type { WordBlock, WordList, WordParagraph } from "./word";
import type { SheetViewport } from "./sheet";
import type { SlideModel, SlideShape } from "./slide";
import type { OfficeExcerptQuery } from "./office-agent";

export type OfficeKind = "word" | "spreadsheet" | "presentation";
export const OFFICE_KINDS: OfficeKind[] = ["word", "spreadsheet", "presentation"];

export function isOfficeKind(kind: string): kind is OfficeKind {
  return OFFICE_KINDS.includes(kind as OfficeKind);
}

export interface OfficeSource {
  key: string;
  kind: OfficeKind;
  format: string;
  assetPath: string;
}

export interface CompatibilityResult {
  type: "compatibility";
  title: string;
  message: string;
}

export interface WordOpenResult {
  type: "word";
  editable: boolean;
  blocks: WordBlock[];
  totalBlocks: number;
  firstPaintMs: number;
  header?: string;
  footer?: string;
}

export interface SpreadsheetOpenResult {
  type: "spreadsheet";
  editable: boolean;
  sheets: Array<{ name: string; rows: number; cols: number }>;
  active: SheetViewport | null;
  firstPaintMs: number;
}

export interface PresentationOpenResult {
  type: "presentation";
  editable: boolean;
  slides: Array<{ index: number; title: string; hidden?: boolean }>;
  active: SlideModel | null;
  firstPaintMs: number;
}

export type OfficeOpenResult = WordOpenResult | SpreadsheetOpenResult | PresentationOpenResult | CompatibilityResult;

export type OfficeMutation =
  | { op: "wordReplace"; index: number; block: WordBlock }
  | { op: "wordInsert"; index: number; block: WordBlock }
  | { op: "wordDelete"; index: number }
  | { op: "wordSplit"; index: number; offset: number }
  | { op: "wordStyle"; index: number; patch: Partial<Pick<WordParagraph, "align" | "kind" | "level" | "style" | "indent" | "lineSpacing" | "pageBreak" | "spacingBefore" | "spacingAfter">> & { list?: WordList | null } }
  | { op: "wordRunStyle"; index: number; style: Partial<WordParagraph["runs"][number]> }
  | { op: "wordFindReplace"; query: string; replacement: string; all?: boolean }
  | { op: "wordTable"; action: "insert" | "insertRow" | "insertCol" | "deleteRow" | "deleteCol" | "setCell"; index: number; row?: number; col?: number; rows?: number; cols?: number; text?: string }
  | { op: "wordHeaderFooter"; header?: string; footer?: string }
  | { op: "sheetEdit"; name: string; row: number; col: number; input: string }
  | { op: "sheetAdd"; name?: string }
  | { op: "sheetInsert"; name: string; axis: "row" | "col"; index: number; count?: number }
  | { op: "sheetDelete"; name: string; axis: "row" | "col"; index: number; count?: number }
  | { op: "sheetFill"; name: string; row: number; col: number; rowCount: number; colCount: number }
  | { op: "sheetFillRight"; name: string; row: number; col: number; rowCount: number; colCount: number }
  | { op: "sheetPaste"; name: string; row: number; col: number; values: string[][] }
  | { op: "sheetFormat"; name: string; row: number; col: number; rowCount: number; colCount: number; format: import("./sheet").CellFormat }
  | { op: "sheetMerge"; name: string; row: number; col: number; rowCount: number; colCount: number; merge: boolean }
  | { op: "sheetSort"; name: string; row: number; col: number; rowCount: number; colCount: number; sortCol?: number; ascending?: boolean }
  | { op: "sheetFreeze"; name: string; row: number; col: number }
  | { op: "sheetFilter"; name: string; row: number; col: number; rowCount: number; colCount: number }
  | { op: "sheetRename"; name: string; next: string }
  | { op: "sheetRemove"; name: string }
  | { op: "sheetAutoSum"; name: string; row: number; col: number; rowCount: number; colCount: number }
  | { op: "sheetWidth"; name: string; col: number; width: number }
  | { op: "slideText"; index: number; shapeId: string; text: string }
  | { op: "slideAdd" }
  | { op: "slideDelete"; index: number }
  | { op: "slideDuplicate"; index: number }
  | { op: "slideBackground"; index: number; background: string }
  | { op: "slideShape"; index: number; shapeId: string; patch: Partial<Pick<SlideShape, "bold" | "italic" | "fontSize" | "align" | "color" | "text" | "fill">> }
  | { op: "slideDeleteShape"; index: number; shapeId: string }
  | { op: "slideAddTextBox"; index: number }
  | { op: "slideMove"; index: number; shapeId: string; x: number; y: number; width?: number; height?: number }
  | { op: "slideNotes"; index: number; notes: string }
  | { op: "slideHide"; index: number; hidden: boolean }
  | { op: "slideLayout"; index: number; layout: "title" | "titleContent" | "blank" | "twoContent" }
  | { op: "slideReorder"; from: number; to: number };

export type OfficeWorkerRequest =
  | { id: number; action: "open"; source: Omit<OfficeSource, "assetPath">; buffer: ArrayBuffer }
  | { id: number; action: "status"; key: string }
  | { id: number; action: "wordChunk"; key: string; offset: number; count: number }
  | { id: number; action: "wordReplace"; key: string; index: number; block: WordBlock }
  | { id: number; action: "wordInsert"; key: string; index: number; block: WordBlock }
  | { id: number; action: "sheetViewport"; key: string; name: string; rowStart: number; rowCount: number; colStart: number; colCount: number }
  | { id: number; action: "sheetEdit"; key: string; name: string; row: number; col: number; input: string }
  | { id: number; action: "sheetAdd"; key: string; name?: string }
  | { id: number; action: "slideGet"; key: string; index: number }
  | { id: number; action: "slideText"; key: string; index: number; shapeId: string; text: string }
  | { id: number; action: "slideAdd"; key: string }
  | { id: number; action: "serialize"; key: string }
  | { id: number; action: "mutate"; key: string; mutation: OfficeMutation }
  | { id: number; action: "undo"; key: string }
  | { id: number; action: "redo"; key: string }
  | { id: number; action: "canUndo"; key: string }
  | { id: number; action: "sheetCopy"; key: string; name: string; row: number; col: number; rowCount: number; colCount: number }
  | { id: number; action: "inspect"; key: string }
  | { id: number; action: "excerpt"; key: string; query?: OfficeExcerptQuery };

export interface OfficeWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export const WORD_INITIAL_BLOCKS = 160;
export const SHEET_INITIAL_ROWS = 80;
export const SHEET_INITIAL_COLS = 26;
