export type EntryKind = "file" | "directory";
export type ViewMode = "read" | "source" | "split" | "live";
export type ThemeMode = "system" | "light" | "dark";

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
  content: string;
  html: string;
  size: number;
  modifiedMs: number;
  cached: boolean;
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
}

export interface TreeNode {
  entry: DocumentEntry;
  children: TreeNode[];
}
