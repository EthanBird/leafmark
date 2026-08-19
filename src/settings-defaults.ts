import { defaultDesktopDockLayout, normalizeDesktopDockLayout } from "./dock-layout";
import { DEFAULT_ENABLED_SKILL_IDS, normalizeEnabledSkills } from "./agent-skills";
import type { AgentSettings, AppSettings } from "./types";

export const SETTINGS_SCHEMA_VERSION = 6;

export function defaultAgentSettings(): AgentSettings {
  return {
    enabled: false,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    topP: 0.95,
    maxTokens: 8192,
    contextChars: 32_000,
    maxToolRounds: 8,
    maxParallelAgents: 3,
    reasoningEffort: "none",
    systemPrompt: "你是一叶 LeafMark 内置的文档 Agent。先理解目标，再使用工具；保持 Markdown、公式、链接和代码完整。",
    allowDocumentEdits: false,
    memoryEnabled: true,
    webToolsEnabled: true,
    terminalToolsEnabled: false,
    allowDestructiveTerminal: false,
    enabledSkills: [...DEFAULT_ENABLED_SKILL_IDS],
    customSkills: "",
    mcpServersJson: "",
  };
}

export function normalizeAgentSettings(value: unknown, options: { migrateOfficeSkills?: boolean } = {}): AgentSettings {
  const defaults = defaultAgentSettings();
  if (!value || typeof value !== "object") return defaults;
  const input = value as Partial<AgentSettings>;
  const rawProvider = (value as { provider?: string }).provider;
  const provider = rawProvider === "openai" ? "openai-api" : rawProvider;
  const rawEffort = String(input.reasoningEffort || "");
  const normalizedEffort = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(rawEffort)
    ? rawEffort as AgentSettings["reasoningEffort"]
    : defaults.reasoningEffort;
  return {
    ...defaults,
    ...input,
    reasoningEffort: normalizedEffort,
    provider: (provider || defaults.provider) as AgentSettings["provider"],
    enabledSkills: normalizeEnabledSkills(input.enabledSkills ?? defaults.enabledSkills, options.migrateOfficeSkills === true),
  };
}

export function defaultAppSettings(workspacePath = ""): AppSettings {
  return {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    workspacePath,
    theme: "system",
    themePalette: "leaf",
    liveEditing: true,
    autosaveDelayMs: 600,
    contentWidth: 860,
    fontFamily: "system",
    fontSize: 16,
    lineHeight: 1.75,
    showStatusBar: true,
    reduceMotion: false,
    mermaidEnabled: true,
    mathEnabled: true,
    desktopLayout: defaultDesktopDockLayout(),
    agent: defaultAgentSettings(),
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = defaultAppSettings();
  if (!value || typeof value !== "object") return defaults;
  const input = value as Partial<AppSettings>;
  const schema = typeof input.settingsSchemaVersion === "number" ? input.settingsSchemaVersion : 0;
  return {
    ...defaults,
    ...input,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    desktopLayout: normalizeDesktopDockLayout(input.desktopLayout ?? defaults.desktopLayout),
    agent: normalizeAgentSettings(input.agent, { migrateOfficeSkills: schema < 6 }),
  };
}
