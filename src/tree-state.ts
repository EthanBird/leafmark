import type { DocumentEntry } from "./types";

const STORAGE_PREFIX = "leafmark.tree.expanded:";

export function treeExpandedStorageKey(workspacePath: string) {
  return `${STORAGE_PREFIX}${workspacePath}`;
}

export function loadTreeExpanded(workspacePath: string): string[] {
  if (!workspacePath || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(treeExpandedStorageKey(workspacePath));
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

export function saveTreeExpanded(workspacePath: string, paths: Iterable<string>) {
  if (!workspacePath || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(treeExpandedStorageKey(workspacePath), JSON.stringify([...paths]));
  } catch {
    /* quota / private mode */
  }
}

export function pruneTreeExpanded(expanded: Iterable<string>, entries: DocumentEntry[]) {
  const directories = new Set(entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path));
  return new Set([...expanded].filter((path) => directories.has(path)));
}
