export type EntryKind = "file" | "directory";
export type ViewMode = "read" | "source" | "split" | "live";
export type ThemeMode = "system" | "light" | "dark";
export type DocumentOrigin = "workspace" | "archive";

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
  origin: DocumentOrigin;
  archiveId: string;
  sourcePath: string;
  sourceExists: boolean;
  content: string;
  html: string;
  size: number;
  modifiedMs: number;
  cached: boolean;
}

export interface ArchiveEntry {
  id: string;
  name: string;
  sourcePath: string;
  lastOpenedMs: number;
  favorite: boolean;
  sourceExists: boolean;
  size: number;
  modifiedMs: number;
}

export interface AssociationStatus {
  supported: boolean;
  registered: boolean;
  isDefault: boolean;
  message: string;
}

export interface AppSettings {
  settingsSchemaVersion: number;
  workspacePath: string;
  theme: ThemeMode;
  liveEditing: boolean;
  autosaveDelayMs: number;
  contentWidth: number;
  fontFamily: string;
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
  library: ArchiveEntry[];
  pendingOpenPaths: string[];
  associationStatus: AssociationStatus;
}

export interface TreeNode {
  entry: DocumentEntry;
  children: TreeNode[];
}
