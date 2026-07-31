import type { DocumentOrigin, LoadedDocument } from "./types";

export interface OpenDocumentTab {
  key: string;
  path: string;
  origin: DocumentOrigin;
  archiveId: string;
  sourcePath: string;
  sourceExists: boolean;
  content: string;
  savedContent: string;
  renderedHtml: string;
  size: number;
  modifiedMs: number;
}

export function documentTabKey(document: Pick<LoadedDocument, "origin" | "archiveId" | "path">) {
  return document.origin === "archive" ? `archive:${document.archiveId || document.path}` : `workspace:${document.path}`;
}

export function tabFromLoadedDocument(document: LoadedDocument): OpenDocumentTab {
  return {
    key: documentTabKey(document),
    path: document.path,
    origin: document.origin,
    archiveId: document.archiveId,
    sourcePath: document.sourcePath,
    sourceExists: document.sourceExists,
    content: document.content,
    savedContent: document.content,
    renderedHtml: document.html,
    size: document.size,
    modifiedMs: document.modifiedMs,
  };
}

export function upsertDocumentTab(tabs: OpenDocumentTab[], document: LoadedDocument): OpenDocumentTab[] {
  const tab = tabFromLoadedDocument(document);
  const index = tabs.findIndex((item) => item.key === tab.key);
  if (index < 0) return [...tabs, tab];
  const next = [...tabs];
  next[index] = tab;
  return next;
}

export function nextTabAfterClose(tabs: OpenDocumentTab[], closingKey: string): OpenDocumentTab | null {
  const index = tabs.findIndex((tab) => tab.key === closingKey);
  if (index < 0 || tabs.length <= 1) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}
