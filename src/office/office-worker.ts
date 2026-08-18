/// <reference lib="webworker" />

import { addSheet, editCell, openSpreadsheet, readViewport, serializeWorkbook, type WorkbookModel } from "./sheet";
import { addBlankSlide, openOdp, openPptx, serializePresentation, updateShapeText, type PresentationDocument } from "./slide";
import { WORD_INITIAL_BLOCKS, SHEET_INITIAL_COLS, SHEET_INITIAL_ROWS, type OfficeOpenResult, type OfficeWorkerRequest, type OfficeWorkerResponse } from "./types";
import { openDocx, openRtf, serializeWord, type WordDocument } from "./word";

const MAX_CACHE_DOCUMENTS = 4;

type CachedDocument = WordDocument | WorkbookModel | PresentationDocument;
const documents = new Map<string, CachedDocument>();

if (typeof self !== "undefined") {
  self.onmessage = (event: MessageEvent<OfficeWorkerRequest>) => {
    void handleRequest(event.data).then(
      (result) => postMessage({ id: event.data.id, result } satisfies OfficeWorkerResponse),
      (error) => postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) } satisfies OfficeWorkerResponse),
    );
  };
}

async function handleRequest(request: OfficeWorkerRequest) {
  if (request.action === "status") {
    const cached = documents.get(request.key);
    return cached ? snapshotResult(cached, 0) : null;
  }
  if (request.action === "open") {
    const started = performance.now();
    const result = openDocument(request.source.key, request.source.kind, request.source.format, request.buffer, started);
    trimCache(request.source.key);
    return result;
  }
  const cached = documents.get(request.key);
  if (!cached) throw new Error("文档缓存已释放，请重新打开标签页");
  touchCache(request.key, cached);
  if (request.action === "wordChunk") {
    const document = asWord(cached);
    return document.blocks.slice(request.offset, request.offset + request.count);
  }
  if (request.action === "wordReplace") {
    const document = asWord(cached);
    document.blocks[request.index] = { ...request.block, dirty: true };
    return true;
  }
  if (request.action === "wordInsert") {
    const document = asWord(cached);
    document.blocks.splice(request.index, 0, { ...request.block, dirty: true });
    return document.blocks.length;
  }
  if (request.action === "sheetViewport") {
    return readViewport(asBook(cached), request.name, request.rowStart, request.rowCount, request.colStart, request.colCount);
  }
  if (request.action === "sheetEdit") {
    const book = asBook(cached);
    editCell(book, request.name, request.row, request.col, request.input);
    return readViewport(book, request.name, Math.max(0, request.row - 20), 60, 0, Math.max(26, asBook(cached).sheets.find((sheet) => sheet.name === request.name)?.cols ?? 26));
  }
  if (request.action === "sheetAdd") {
    const book = asBook(cached);
    const name = addSheet(book, request.name);
    return { name, sheets: book.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, cols: sheet.cols })) };
  }
  if (request.action === "slideGet") {
    const presentation = asPresentation(cached);
    return presentation.slides[request.index] ?? presentation.slides[0] ?? null;
  }
  if (request.action === "slideText") {
    const presentation = asPresentation(cached);
    const slide = presentation.slides[request.index];
    if (slide) updateShapeText(slide, request.shapeId, request.text);
    return slide ?? null;
  }
  if (request.action === "slideAdd") {
    const presentation = asPresentation(cached);
    const slide = addBlankSlide(presentation);
    return { slide, slides: presentation.slides.map((item) => ({ index: item.index, title: item.title })) };
  }
  return serializeCached(cached);
}

function openDocument(key: string, kind: string, format: string, buffer: ArrayBuffer, started: number): OfficeOpenResult {
  const normalized = format.toLowerCase();
  const firstPaintMs = () => Math.max(0, Math.round(performance.now() - started));
  if (kind === "word") {
    if (normalized === "docx") {
      const document = openDocx(buffer);
      cache(key, document);
      return { type: "word", editable: true, blocks: document.blocks.slice(0, WORD_INITIAL_BLOCKS), totalBlocks: document.blocks.length, firstPaintMs: firstPaintMs() };
    }
    if (normalized === "rtf") {
      const document = openRtf(buffer);
      cache(key, document);
      return { type: "word", editable: true, blocks: document.blocks.slice(0, WORD_INITIAL_BLOCKS), totalBlocks: document.blocks.length, firstPaintMs: firstPaintMs() };
    }
    return compatibility("旧版 Word 文档", "二进制 .doc 需要 Microsoft Office 排版引擎才能完整还原。原件已安全保留，可交给系统应用打开。");
  }
  if (kind === "spreadsheet") {
    const workbook = openSpreadsheet(buffer, normalized);
    cache(key, workbook);
    const first = workbook.sheets[0];
    return {
      type: "spreadsheet",
      editable: workbook.editable,
      sheets: workbook.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, cols: sheet.cols })),
      active: first ? readViewport(workbook, first.name, 0, SHEET_INITIAL_ROWS, 0, Math.max(SHEET_INITIAL_COLS, first.cols)) : null,
      firstPaintMs: firstPaintMs(),
    };
  }
  if (kind === "presentation") {
    if (normalized === "pptx") {
      const presentation = openPptx(buffer);
      cache(key, presentation);
      return {
        type: "presentation",
        editable: true,
        slides: presentation.slides.map((slide) => ({ index: slide.index, title: slide.title })),
        active: presentation.slides[0] ?? null,
        firstPaintMs: firstPaintMs(),
      };
    }
    if (normalized === "odp") {
      const presentation = openOdp(buffer);
      cache(key, presentation);
      return {
        type: "presentation",
        editable: true,
        slides: presentation.slides.map((slide) => ({ index: slide.index, title: slide.title })),
        active: presentation.slides[0] ?? null,
        firstPaintMs: firstPaintMs(),
      };
    }
    return compatibility("旧版 PowerPoint 文档", "二进制 .ppt 需要 Microsoft Office 排版引擎才能完整还原。原件已安全保留，可交给系统应用打开。");
  }
  return compatibility("暂不支持的格式", `无法解析 ${format.toUpperCase()} 文档。`);
}

function snapshotResult(cached: CachedDocument, firstPaintMs: number): OfficeOpenResult {
  if ("blocks" in cached) {
    return { type: "word", editable: true, blocks: cached.blocks.slice(0, WORD_INITIAL_BLOCKS), totalBlocks: cached.blocks.length, firstPaintMs };
  }
  if ("sharedStrings" in cached) {
    const first = cached.sheets[0];
    return {
      type: "spreadsheet",
      editable: cached.editable,
      sheets: cached.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, cols: sheet.cols })),
      active: first ? readViewport(cached, first.name, 0, SHEET_INITIAL_ROWS, 0, Math.max(SHEET_INITIAL_COLS, first.cols)) : null,
      firstPaintMs,
    };
  }
  return {
    type: "presentation",
    editable: cached.editable,
    slides: cached.slides.map((slide) => ({ index: slide.index, title: slide.title })),
    active: cached.slides[0] ?? null,
    firstPaintMs,
  };
}

function serializeCached(cached: CachedDocument) {
  if ("blocks" in cached) return serializeWord(cached);
  if ("sharedStrings" in cached) return serializeWorkbook(cached);
  return serializePresentation(cached);
}

function asWord(cached: CachedDocument): WordDocument {
  if (!("blocks" in cached)) throw new Error("当前文档不是 Word 文档");
  return cached;
}

function asBook(cached: CachedDocument): WorkbookModel {
  if (!("sharedStrings" in cached)) throw new Error("当前文档不是电子表格");
  return cached;
}

function asPresentation(cached: CachedDocument): PresentationDocument {
  if (!("slides" in cached) || !("width" in cached)) throw new Error("当前文档不是演示文稿");
  return cached;
}

function compatibility(title: string, message: string): OfficeOpenResult {
  return { type: "compatibility", title, message };
}

function cache(key: string, document: CachedDocument) {
  documents.delete(key);
  documents.set(key, document);
}

function touchCache(key: string, document: CachedDocument) {
  documents.delete(key);
  documents.set(key, document);
}

function trimCache(activeKey: string) {
  while (documents.size > MAX_CACHE_DOCUMENTS) {
    const oldest = documents.keys().next().value as string | undefined;
    if (!oldest) break;
    if (oldest === activeKey && documents.size > 1) {
      touchCache(oldest, documents.get(oldest)!);
      continue;
    }
    documents.delete(oldest);
  }
}

export function openWordForTest(key: string, buffer: ArrayBuffer) {
  return openDocument(key, "word", "docx", buffer, performance.now());
}
