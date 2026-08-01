export type EntryKind = "file" | "directory";
export type ViewMode = "read" | "source" | "split" | "live";
export type ThemeMode = "system" | "light" | "dark";
export type ThemePalette = "leaf" | "sakura" | "qingchuan" | "amber" | "wisteria" | "monochrome";
export type DocumentOrigin = "workspace" | "archive";
export type DockPanelId = "workspace" | "history" | "favorites" | "agent" | "outline";
export type DockZone = "left" | "right" | "top" | "bottom";
export type AgentProvider =
  | "openai-oauth"
  | "claude-oauth"
  | "gemini-oauth"
  | "copilot"
  | "openai-api"
  | "anthropic-api"
  | "gemini-api"
  | "deepseek"
  | "openrouter"
  | "opencode"
  | "opencode-go"
  | "zai"
  | "kimi"
  | "302ai"
  | "baseten"
  | "cortecs"
  | "comtegra"
  | "fpt"
  | "firmware"
  | "huggingface"
  | "moonshotai"
  | "nebius"
  | "scaleway"
  | "stackit"
  | "groq"
  | "mistral"
  | "perplexity"
  | "togetherai"
  | "deepinfra"
  | "fireworks"
  | "minimax"
  | "xai"
  | "chutes"
  | "cerebras"
  | "alibaba-coding-plan"
  | "nvidia-nim"
  | "xiaomi-mimo"
  | "celeris"
  | "ollama"
  | "lmstudio"
  | "custom";

export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  reasoningEffort: AgentReasoningEffort;
  systemPrompt: string;
  allowDocumentEdits: boolean;
  memoryEnabled: boolean;
  webToolsEnabled: boolean;
  terminalToolsEnabled: boolean;
  allowDestructiveTerminal: boolean;
  enabledSkills: string[];
  customSkills: string;
  mcpServersJson: string;
}

export interface AgentAuthChallenge {
  flowId: string;
  provider: string;
  authorizeUrl: string;
  userCode: string | null;
  message: string;
}

export interface AgentAuthFlowStatus {
  status: "pending" | "success" | "error";
  message: string;
}

export interface AgentAuthAccountStatus {
  provider: string;
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
  detail: string;
}

export interface AgentCredential {
  accessToken: string;
  accountId: string | null;
  expiresAt: number | null;
  apiBase: string | null;
}

export interface AgentTerminalResult {
  jobId: string | null;
  status: "running" | "completed" | "timed_out" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface AgentVersionChange {
  target: string;
  kind: "created" | "modified" | "deleted";
  size: number;
}

export interface AgentVersionSummary {
  id: string;
  sessionId: string;
  turnId: string;
  label: string;
  createdMs: number;
  outcome: "completed" | "failed" | "interrupted" | "recovered";
  changes: AgentVersionChange[];
}

export interface AgentVersionOperation {
  version: AgentVersionSummary;
  direction: "undo" | "redo";
}

export interface AgentVersionStatus {
  undo: AgentVersionSummary | null;
  redo: AgentVersionSummary | null;
  pending: boolean;
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
