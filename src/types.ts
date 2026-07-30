export type EntryKind = "file" | "directory";
export type ViewMode = "read" | "source" | "split" | "live";
export type ThemeMode = "system" | "light" | "dark";
export type DocumentOrigin = "workspace" | "external" | "snapshot";

export interface DocumentEntry {
  path: string;
  name: string;
  kind: EntryKind;
  depth: number;
  size: number;
  modifiedMs: number;
}

export interface LoadedDocument {
  path: string;
  sourcePath: string;
  name: string;
  content: string;
  html: string;
  size: number;
  modifiedMs: number;
  cached: boolean;
  origin: DocumentOrigin;
  recordId: string;
  sourceExists: boolean;
  writable: boolean;
}

export interface ArchiveRecord {
  id: string;
  sourcePath: string;
  name: string;
  snapshotPath: string;
  lastOpenedMs: number;
  modifiedMs: number;
  size: number;
  favorite: boolean;
  sourceExists: boolean;
}

export interface AppSettings {
  workspacePath: string;
  theme: ThemeMode;
  liveEditing: boolean;
  autosaveDelayMs: number;
  contentWidth: number;
  fontSize: number;
  lineHeight: number;
  showStatusBar: boolean;
  reduceMotion: boolean;
  mermaidEnabled: boolean;
  mathEnabled: boolean;
}

export interface BootstrapPayload {
  settings: AppSettings;
  entries: DocumentEntry[];
  records: ArchiveRecord[];
  pendingOpenPaths: string[];
}

export interface TreeNode {
  entry: DocumentEntry;
  children: TreeNode[];
}
