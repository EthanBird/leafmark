import type { DocumentKind } from "./types";

export interface ViewerSource {
  key: string;
  kind: Exclude<DocumentKind, "markdown" | "pdf" | "unsupported">;
  format: string;
  assetPath: string;
}

export interface WordBlock {
  kind: "paragraph" | "heading" | "table";
  text?: string;
  level?: number;
  rows?: string[][];
}

export interface WordDocumentResult {
  type: "word";
  blocks: WordBlock[];
  totalBlocks: number;
}

export interface SpreadsheetSheet {
  name: string;
  rows: string[][];
  startRow: number;
  totalRows: number;
  totalColumns: number;
}

export interface SpreadsheetDocumentResult {
  type: "spreadsheet";
  sheets: Array<{ name: string; rows: number; columns: number }>;
  active: SpreadsheetSheet | null;
}

export interface PresentationShape {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
}

export interface PresentationSlide {
  index: number;
  title: string;
  background: string;
  shapes: PresentationShape[];
  imageCount: number;
}

export interface PresentationDocumentResult {
  type: "presentation";
  slides: Array<{ index: number; title: string }>;
  active: PresentationSlide | null;
}

export interface CompatibilityResult {
  type: "compatibility";
  title: string;
  message: string;
}

export type ViewerResult =
  | WordDocumentResult
  | SpreadsheetDocumentResult
  | PresentationDocumentResult
  | CompatibilityResult;

export type DocumentWorkerRequest =
  | { id: number; action: "open"; source: Omit<ViewerSource, "assetPath">; buffer: ArrayBuffer }
  | { id: number; action: "wordChunk"; key: string; offset: number; count: number }
  | { id: number; action: "sheet"; key: string; name: string; offset: number; count: number }
  | { id: number; action: "slide"; key: string; index: number };

export interface DocumentWorkerResponse {
  id: number;
  result?: ViewerResult | WordBlock[] | SpreadsheetSheet | PresentationSlide;
  error?: string;
}
