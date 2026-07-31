export type EntryKind = "file" | "directory";
export type ViewMode = "read" | "source" | "split" | "live";
export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "leaf" | "sakura" | "qingchuan" | "amber" | "wisteria";
export type DocumentOrigin = "workspace" | "archive";
export type DockPanelId = "workspace" | "history" | "favorites" | "agent" | "outline";
export type DockZone = "left" | "right" | "top" | "bottom";
export type AgentProvider = "openai" | "deepseek" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface DockZoneState {
  panels: DockPanelId[];
  active: DockPanelId | null;
}

export interface DesktopDockLayout {
  zones: Record<DockZone, DockZoneState>;
  hidden: DockPanelId[];
  leftSize: number;
  rightSize: number;
  topSize: number;
  bottomSize: number;
}

export interface AgentSettings {
  enabled: boolean;
  provider: AgentProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  contextChars: number;
  maxToolRounds: number;
  maxParallelAgents: number;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
  systemPrompt: string;
  allowDocumentEdits: boolean;
  memoryEnabled: boolean;
  webToolsEnabled: boolean;
  enabledSkills: string[];
  customSkills: string;
  mcpServersJson: string;
}

export interface DocumentEntry {
  path: string;
  name: string;
  kind: EntryKind;
  depth: number;
  size: number;
  modifiedMs: number;
}

export interface ImportDirectoryResult {
  rootPath: string;
  files: string[];
  directories: number;
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
  themePalette: ThemePalette;
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
  desktopLayout: DesktopDockLayout;
  agent: AgentSettings;
}

export interface BootstrapPayload {
  settings: AppSettings;
  entries: DocumentEntry[];
  library: ArchiveEntry[];
  initialDocument: LoadedDocument | null;
  pendingOpenPaths: string[];
  associationStatus: AssociationStatus;
}

export interface TreeNode {
  entry: DocumentEntry;
  children: TreeNode[];
}
