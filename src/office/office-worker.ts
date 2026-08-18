/// <reference lib="webworker" />

import { LruCache } from "./core/lru";
import { OfficeSession } from "./core/session";
import { openOfficeModel } from "./core/codec";
import type { OfficeOpenResult, OfficeWorkerRequest, OfficeWorkerResponse } from "./types";

const sessions = new LruCache<OfficeSession>(4);

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
    return sessions.get(request.key)?.snapshot() ?? null;
  }
  if (request.action === "open") {
    const started = performance.now();
    const opened = OfficeSession.open(request.source.kind, request.source.format, request.buffer);
    if (!(opened instanceof OfficeSession)) return opened;
    sessions.set(request.source.key, opened);
    return opened.snapshot(Math.max(0, Math.round(performance.now() - started)));
  }
  const session = sessions.get(request.key);
  if (!session) throw new Error("文档缓存已释放，请重新打开标签页");
  sessions.set(request.key, session);
  if (request.action === "wordChunk") return session.wordChunk(request.offset, request.count);
  if (request.action === "wordReplace") return session.mutate({ op: "wordReplace", index: request.index, block: request.block });
  if (request.action === "wordInsert") return session.mutate({ op: "wordInsert", index: request.index, block: request.block });
  if (request.action === "sheetViewport") return session.sheetViewport(request.name, request.rowStart, request.rowCount, request.colStart, request.colCount);
  if (request.action === "sheetEdit") {
    const result = session.mutate({ op: "sheetEdit", name: request.name, row: request.row, col: request.col, input: request.input }) as { active: unknown };
    return result.active;
  }
  if (request.action === "sheetAdd") return session.mutate({ op: "sheetAdd", name: request.name });
  if (request.action === "slideGet") return session.slideAt(request.index);
  if (request.action === "slideText") {
    const result = session.mutate({ op: "slideText", index: request.index, shapeId: request.shapeId, text: request.text }) as { slide: unknown };
    return result.slide;
  }
  if (request.action === "slideAdd") return session.mutate({ op: "slideAdd" });
  if (request.action === "mutate") return session.mutate(request.mutation);
  if (request.action === "undo") return { ok: session.undoOnce(), snapshot: session.snapshot() };
  if (request.action === "redo") return { ok: session.redoOnce(), snapshot: session.snapshot() };
  if (request.action === "canUndo") return { undo: session.undo.canUndo, redo: session.undo.canRedo };
  if (request.action === "sheetCopy") return session.copyCells(request.name, request.row, request.col, request.rowCount, request.colCount);
  if (request.action === "inspect") return session.inspect();
  if (request.action === "excerpt") return session.excerpt(request.query);
  return session.serialize();
}

export function openWordForTest(key: string, buffer: ArrayBuffer) {
  const opened = openOfficeModel("word", "docx", buffer);
  if (opened.type === "compatibility") return opened;
  const session = new OfficeSession("word", "docx", opened);
  sessions.set(key, session);
  return session.snapshot();
}
