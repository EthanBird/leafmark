import { convertFileSrc } from "@tauri-apps/api/core";
import type { WordBlock } from "./word";
import type { SheetViewport } from "./sheet";
import type { SlideModel } from "./slide";
import type { OfficeExcerptQuery, OfficeInspectResult } from "./office-agent";
import type {
  OfficeMutation,
  OfficeOpenResult,
  OfficeSource,
  OfficeWorkerRequest,
  OfficeWorkerResponse,
} from "./types";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
const inflight = new Map<string, Promise<OfficeOpenResult>>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./office-worker.ts", import.meta.url), { type: "module", name: "leafmark-office-engine" });
  worker.onmessage = (event: MessageEvent<OfficeWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Office 引擎 Worker 异常退出");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    inflight.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

type WorkerRequestWithoutId = OfficeWorkerRequest extends infer Request
  ? Request extends OfficeWorkerRequest ? Omit<Request, "id"> : never
  : never;

function callWorker<T>(request: WorkerRequestWithoutId, transfer: Transferable[] = []): Promise<T> {
  const id = ++sequence;
  const message = { ...request, id } as OfficeWorkerRequest;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage(message, transfer);
  });
}

export function officeAssetUrl(assetPath: string) {
  return convertFileSrc(assetPath);
}

export function openOfficeFromBuffer(
  source: Pick<OfficeSource, "key" | "kind" | "format">,
  buffer: ArrayBuffer,
): Promise<OfficeOpenResult> {
  return callWorker<OfficeOpenResult>({
    action: "open",
    source: { key: source.key, kind: source.kind, format: source.format },
    buffer,
  }, [buffer]);
}

export function openOfficeDocument(source: OfficeSource): Promise<OfficeOpenResult> {
  const existing = inflight.get(source.key);
  if (existing) return existing;
  const promise = callWorker<OfficeOpenResult | null>({ action: "status", key: source.key })
    .catch(() => null)
    .then((current) => {
      if (current) return current;
      return fetch(officeAssetUrl(source.assetPath))
        .then((response) => {
          if (!response.ok) throw new Error(`无法读取保留副本（HTTP ${response.status}）`);
          return response.arrayBuffer();
        })
        .then((buffer) => callWorker<OfficeOpenResult>({
          action: "open",
          source: { key: source.key, kind: source.kind, format: source.format },
          buffer,
        }, [buffer]));
    })
    .finally(() => inflight.delete(source.key));
  inflight.set(source.key, promise);
  return promise;
}

export function forgetOfficeDocument(key: string) {
  inflight.delete(key);
}

export function loadWordChunk(key: string, offset: number, count = 200) {
  return callWorker<WordBlock[]>({ action: "wordChunk", key, offset, count });
}

export function replaceWordBlock(key: string, index: number, block: WordBlock) {
  return callWorker<boolean>({ action: "wordReplace", key, index, block });
}

export function insertWordBlock(key: string, index: number, block: WordBlock) {
  return callWorker<number>({ action: "wordInsert", key, index, block });
}

export function loadSheetViewport(key: string, name: string, rowStart: number, rowCount: number, colStart: number, colCount: number) {
  return callWorker<SheetViewport>({ action: "sheetViewport", key, name, rowStart, rowCount, colStart, colCount });
}

export function editSheetCell(key: string, name: string, row: number, col: number, input: string) {
  return callWorker<SheetViewport>({ action: "sheetEdit", key, name, row, col, input });
}

export function addWorkbookSheet(key: string, name?: string) {
  return callWorker<{ name: string; sheets: Array<{ name: string; rows: number; cols: number }> }>({ action: "sheetAdd", key, name });
}

export function loadPresentationSlide(key: string, index: number) {
  return callWorker<SlideModel | null>({ action: "slideGet", key, index });
}

export function updatePresentationShape(key: string, index: number, shapeId: string, text: string) {
  return callWorker<SlideModel | null>({ action: "slideText", key, index, shapeId, text });
}

export function addPresentationSlide(key: string) {
  return callWorker<{ slide: SlideModel; slides: Array<{ index: number; title: string }> }>({ action: "slideAdd", key });
}

export function mutateOffice(key: string, mutation: OfficeMutation) {
  return callWorker<unknown>({ action: "mutate", key, mutation });
}

export function inspectOfficeDocument(key: string) {
  return callWorker<OfficeInspectResult>({ action: "inspect", key });
}

export function excerptOfficeDocument(key: string, query: OfficeExcerptQuery = {}) {
  return callWorker<string>({ action: "excerpt", key, query });
}

export function officeDocumentStatus(key: string) {
  return callWorker<OfficeOpenResult | null>({ action: "status", key });
}

export function copySheetRange(key: string, name: string, row: number, col: number, rowCount: number, colCount: number) {
  return callWorker<string[][]>({ action: "sheetCopy", key, name, row, col, rowCount, colCount });
}

export function undoOffice(key: string) {
  return callWorker<{ ok: boolean; snapshot: OfficeOpenResult }>({ action: "undo", key });
}

export function redoOffice(key: string) {
  return callWorker<{ ok: boolean; snapshot: OfficeOpenResult }>({ action: "redo", key });
}

export async function serializeOfficeDocument(key: string) {
  const result = await callWorker<ArrayBuffer | Uint8Array>({ action: "serialize", key });
  return result instanceof Uint8Array ? result : new Uint8Array(result);
}

export function isOfficeEditableFormat(kind: string, format: string) {
  const normalized = format.toLowerCase();
  if (kind === "word") return normalized === "docx" || normalized === "rtf";
  if (kind === "spreadsheet") return ["xlsx", "xls", "xlsb", "ods", "csv"].includes(normalized);
  if (kind === "presentation") return normalized === "pptx" || normalized === "odp";
  return false;
}
