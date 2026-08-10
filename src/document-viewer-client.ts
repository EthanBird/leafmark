import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  DocumentWorkerRequest,
  DocumentWorkerResponse,
  PresentationSlide,
  SpreadsheetSheet,
  ViewerResult,
  ViewerSource,
  WordBlock,
} from "./document-viewer-types";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
const openDocuments = new Map<string, Promise<ViewerResult>>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./document-worker.ts", import.meta.url), { type: "module", name: "leafmark-document-parser" });
  worker.onmessage = (event: MessageEvent<DocumentWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "文档解析 Worker 异常退出");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    openDocuments.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

type WorkerRequestWithoutId = DocumentWorkerRequest extends infer Request
  ? Request extends DocumentWorkerRequest ? Omit<Request, "id"> : never
  : never;

function callWorker<T>(request: WorkerRequestWithoutId, transfer: Transferable[] = []): Promise<T> {
  const id = ++sequence;
  const message = { ...request, id } as DocumentWorkerRequest;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage(message, transfer);
  });
}

export function officeAssetUrl(assetPath: string) {
  return convertFileSrc(assetPath);
}

export function openViewerDocument(source: ViewerSource): Promise<ViewerResult> {
  const existing = openDocuments.get(source.key);
  if (existing) return existing;
  const promise = fetch(officeAssetUrl(source.assetPath))
    .then((response) => {
      if (!response.ok) throw new Error(`无法读取保留副本（HTTP ${response.status}）`);
      return response.arrayBuffer();
    })
    .then((buffer) => callWorker<ViewerResult>({
      action: "open",
      source: { key: source.key, kind: source.kind, format: source.format },
      buffer,
    }, [buffer]))
    .catch((error) => {
      openDocuments.delete(source.key);
      throw error;
    });
  openDocuments.set(source.key, promise);
  return promise;
}

export function loadWordChunk(key: string, offset: number, count = 200) {
  return callWorker<WordBlock[]>({ action: "wordChunk", key, offset, count });
}

export function loadSheetChunk(key: string, name: string, offset: number, count = 200) {
  return callWorker<SpreadsheetSheet>({ action: "sheet", key, name, offset, count });
}

export function loadPresentationSlide(key: string, index: number) {
  return callWorker<PresentationSlide>({ action: "slide", key, index });
}
