/// <reference lib="webworker" />

import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "@e965/xlsx";
import type {
  CompatibilityResult,
  DocumentWorkerRequest,
  DocumentWorkerResponse,
  PresentationDocumentResult,
  PresentationShape,
  PresentationSlide,
  SpreadsheetDocumentResult,
  SpreadsheetSheet,
  ViewerResult,
  WordBlock,
  WordDocumentResult,
} from "./document-viewer-types";

const WORD_INITIAL_BLOCKS = 160;
const SHEET_INITIAL_ROWS = 120;
const MAX_SHEET_COLUMNS = 160;
const MAX_XML_BYTES = 96 * 1024 * 1024;
const MAX_CACHE_DOCUMENTS = 4;

interface CachedWord {
  type: "word";
  blocks: WordBlock[];
}

interface CachedSpreadsheet {
  type: "spreadsheet";
  workbook: XLSX.WorkBook;
}

interface CachedPresentation {
  type: "presentation";
  slides: PresentationSlide[];
}

type CachedDocument = CachedWord | CachedSpreadsheet | CachedPresentation;
const documents = new Map<string, CachedDocument>();

if (typeof self !== "undefined") {
  self.onmessage = (event: MessageEvent<DocumentWorkerRequest>) => {
    void handleRequest(event.data).then(
      (result) => postMessage({ id: event.data.id, result } satisfies DocumentWorkerResponse),
      (error) => postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) } satisfies DocumentWorkerResponse),
    );
  };
}

async function handleRequest(request: DocumentWorkerRequest) {
  if (request.action === "open") {
    const result = openDocument(request.source.key, request.source.kind, request.source.format, request.buffer);
    trimCache(request.source.key);
    return result;
  }
  const cached = documents.get(request.key);
  if (!cached) throw new Error("文档缓存已释放，请重新打开标签页");
  touchCache(request.key, cached);
  if (request.action === "wordChunk") {
    if (cached.type !== "word") throw new Error("当前文档不是 Word 文档");
    return cached.blocks.slice(request.offset, request.offset + request.count);
  }
  if (request.action === "sheet") {
    if (cached.type !== "spreadsheet") throw new Error("当前文档不是电子表格");
    return readSheet(cached.workbook, request.name, request.offset, request.count);
  }
  if (cached.type !== "presentation") throw new Error("当前文档不是演示文稿");
  return cached.slides[request.index] ?? cached.slides[0] ?? null;
}

function openDocument(key: string, kind: string, format: string, buffer: ArrayBuffer): ViewerResult {
  const normalizedFormat = format.toLowerCase();
  if (kind === "word") {
    if (normalizedFormat === "docx") return openDocx(key, buffer);
    if (normalizedFormat === "rtf") return openRtf(key, buffer);
    return compatibility("旧版 Word 文档", "二进制 .doc 需要 Microsoft Office 或 LibreOffice 的排版引擎。原件已安全保留，可交给系统应用打开。");
  }
  if (kind === "spreadsheet") return openSpreadsheet(key, buffer);
  if (kind === "presentation") {
    if (normalizedFormat === "pptx") return openPptx(key, buffer);
    if (normalizedFormat === "odp") return openOdp(key, buffer);
    return compatibility("旧版 PowerPoint 文档", "二进制 .ppt 需要 Microsoft Office 或 LibreOffice 的排版引擎。原件已安全保留，可交给系统应用打开。");
  }
  return compatibility("暂不支持的格式", `无法解析 ${format.toUpperCase()} 文档。`);
}

export function openDocx(key: string, buffer: ArrayBuffer): WordDocumentResult {
  const files = unzipXml(buffer, (name) => name === "word/document.xml");
  const xml = textFile(files, "word/document.xml");
  const blocks = parseWordBlocks(xml);
  cache(key, { type: "word", blocks });
  return { type: "word", blocks: blocks.slice(0, WORD_INITIAL_BLOCKS), totalBlocks: blocks.length };
}

function openRtf(key: string, buffer: ArrayBuffer): WordDocumentResult {
  const source = new TextDecoder("utf-8").decode(buffer);
  const text = source
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => String.fromCharCode((Number(value) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const blocks: WordBlock[] = text.split(/\n+/).filter(Boolean).map((value) => ({ kind: "paragraph", text: value }));
  cache(key, { type: "word", blocks });
  return { type: "word", blocks: blocks.slice(0, WORD_INITIAL_BLOCKS), totalBlocks: blocks.length };
}

export function parseWordBlocks(xml: string): WordBlock[] {
  const blocks: WordBlock[] = [];
  const tokenPattern = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  for (const match of xml.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith("<w:tbl")) {
      const rows = [...token.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((row) =>
        [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cell) => extractXmlText(cell[0])),
      );
      if (rows.length) blocks.push({ kind: "table", rows });
      continue;
    }
    const text = extractXmlText(token);
    if (!text) continue;
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/i.exec(token)?.[1] ?? "";
    const heading = /(?:heading|标题)\s*([1-6])/i.exec(style);
    blocks.push(heading
      ? { kind: "heading", text, level: Number(heading[1]) }
      : { kind: "paragraph", text });
  }
  return blocks;
}

export function openSpreadsheet(key: string, buffer: ArrayBuffer): SpreadsheetDocumentResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true,
      cellStyles: false,
      cellHTML: false,
      cellFormula: true,
      bookVBA: false,
      dense: true,
    });
  } catch (error) {
    throw new Error(`电子表格解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  cache(key, { type: "spreadsheet", workbook });
  const sheets = workbook.SheetNames.map((name) => {
    const range = sheetRange(workbook.Sheets[name]);
    return { name, rows: range.rows, columns: range.columns };
  });
  const first = workbook.SheetNames[0];
  return {
    type: "spreadsheet",
    sheets,
    active: first ? readSheet(workbook, first, 0, SHEET_INITIAL_ROWS) : null,
  };
}

function readSheet(workbook: XLSX.WorkBook, name: string, offset: number, count: number): SpreadsheetSheet {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`找不到工作表：${name}`);
  const dimension = sheetRange(sheet);
  const endRow = Math.min(dimension.rows, offset + count);
  const endColumn = Math.min(dimension.columns, MAX_SHEET_COLUMNS);
  const rows: string[][] = [];
  const denseRows = ((sheet as XLSX.WorkSheet & { "!data"?: Array<Array<XLSX.CellObject | undefined>> })["!data"]
    ?? (Array.isArray(sheet) ? sheet as unknown as Array<Array<XLSX.CellObject | undefined>> : null));
  for (let row = offset; row < endRow; row += 1) {
    const values: string[] = [];
    for (let column = 0; column < endColumn; column += 1) {
      const cell = denseRows?.[row]?.[column] ?? sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      values.push(cell ? String(cell.w ?? cell.v ?? "") : "");
    }
    while (values.length && values[values.length - 1] === "") values.pop();
    rows.push(values);
  }
  return { name, rows, startRow: offset, totalRows: dimension.rows, totalColumns: dimension.columns };
}

function sheetRange(sheet: XLSX.WorkSheet | undefined) {
  if (!sheet?.["!ref"]) return { rows: 0, columns: 0 };
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  return { rows: range.e.r + 1, columns: range.e.c + 1 };
}

export function openPptx(key: string, buffer: ArrayBuffer): PresentationDocumentResult {
  const files = unzipXml(buffer, (name) => name.startsWith("ppt/slides/slide") || name === "ppt/presentation.xml");
  const presentation = textFile(files, "ppt/presentation.xml", false);
  const sizeMatch = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentation);
  const width = Number(sizeMatch?.[1] ?? 12_192_000);
  const height = Number(sizeMatch?.[2] ?? 6_858_000);
  const names = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const slides = names.map((name, index) => parsePptxSlide(textFile(files, name), index, width, height));
  cache(key, { type: "presentation", slides });
  return {
    type: "presentation",
    slides: slides.map(({ index, title }) => ({ index, title })),
    active: slides[0] ?? null,
  };
}

function parsePptxSlide(xml: string, index: number, slideWidth: number, slideHeight: number): PresentationSlide {
  const background = /<p:bg[\s\S]*?<a:srgbClr[^>]*val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1] ?? "ffffff";
  const shapes: PresentationShape[] = [];
  for (const match of xml.matchAll(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g)) {
    const shape = match[0];
    const text = extractXmlText(shape);
    if (!text) continue;
    const transform = /<a:xfrm[^>]*>[\s\S]*?<a:off[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(shape);
    const fontSize = Number(/<a:rPr[^>]*sz="(\d+)"/.exec(shape)?.[1] ?? /<a:defRPr[^>]*sz="(\d+)"/.exec(shape)?.[1] ?? 1800) / 100;
    const color = /<a:srgbClr[^>]*val="([0-9A-Fa-f]{6})"/.exec(shape)?.[1] ?? "202124";
    const alignValue = /<a:pPr[^>]*algn="([^"]+)"/.exec(shape)?.[1];
    shapes.push({
      x: transform ? Number(transform[1]) / slideWidth : 0.08,
      y: transform ? Number(transform[2]) / slideHeight : 0.08 + shapes.length * 0.1,
      width: transform ? Number(transform[3]) / slideWidth : 0.84,
      height: transform ? Number(transform[4]) / slideHeight : 0.12,
      text,
      fontSize: Math.max(10, Math.min(54, fontSize)),
      color: `#${color}`,
      bold: /<a:rPr[^>]*b="1"/.test(shape),
      align: alignValue === "ctr" ? "center" : alignValue === "r" ? "right" : "left",
    });
  }
  const imageCount = [...xml.matchAll(/<p:pic(?:\s|>)/g)].length;
  return { index, title: shapes[0]?.text.slice(0, 80) || `幻灯片 ${index + 1}`, background: `#${background}`, shapes, imageCount };
}

function openOdp(key: string, buffer: ArrayBuffer): PresentationDocumentResult {
  const files = unzipXml(buffer, (name) => name === "content.xml");
  const xml = textFile(files, "content.xml");
  const pages = [...xml.matchAll(/<draw:page(?:\s[^>]*)?>[\s\S]*?<\/draw:page>/g)];
  const slides = pages.map((page, index) => {
    const paragraphs = [...page[0].matchAll(/<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/g)]
      .map((item) => decodeXml(item[1].replace(/<[^>]+>/g, " ")).trim())
      .filter(Boolean);
    return {
      index,
      title: paragraphs[0]?.slice(0, 80) || `幻灯片 ${index + 1}`,
      background: "#ffffff",
      shapes: paragraphs.map((text, shapeIndex) => ({
        x: 0.08, y: 0.08 + shapeIndex * 0.11, width: 0.84, height: 0.1,
        text, fontSize: shapeIndex === 0 ? 28 : 18, color: "#202124", bold: shapeIndex === 0, align: "left" as const,
      })),
      imageCount: 0,
    };
  });
  cache(key, { type: "presentation", slides });
  return { type: "presentation", slides: slides.map(({ index, title }) => ({ index, title })), active: slides[0] ?? null };
}

function unzipXml(buffer: ArrayBuffer, filter: (name: string) => boolean) {
  let expandedBytes = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      const include = filter(file.name);
      if (include) {
        expandedBytes += file.originalSize;
        if (expandedBytes > MAX_XML_BYTES) throw new Error("文档 XML 超过 96 MB，已停止解析以保护内存");
      }
      return include;
    },
  });
  return files;
}

function textFile(files: Record<string, Uint8Array>, name: string, required = true) {
  const file = files[name];
  if (!file) {
    if (required) throw new Error(`文档结构不完整：缺少 ${name}`);
    return "";
  }
  return strFromU8(file);
}

function extractXmlText(xml: string) {
  return [...xml.matchAll(/<(?:w:t|a:t|text:span|text:p)(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:t|a:t|text:span|text:p)>/g)]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, " ")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function slideNumber(name: string) {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function compatibility(title: string, message: string): CompatibilityResult {
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
      const current = documents.get(oldest)!;
      touchCache(oldest, current);
      continue;
    }
    documents.delete(oldest);
  }
}
