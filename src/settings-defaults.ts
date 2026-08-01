import { defaultDesktopDockLayout } from "./dock-layout";
import type { AgentSettings, AppSettings } from "./types";

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
    enabledSkills: ["writing", "proofread", "summarize", "structure"],
    customSkills: "",
    mcpServersJson: "",
  };
}

export function normalizeAgentSettings(value: unknown): AgentSettings {
  const defaults = defaultAgentSettings();
  if (!value || typeof value !== "object") return defaults;
  const input = value as Partial<AgentSettings>;
  const rawProvider = (value as { provider?: string }).provider;
  const provider = rawProvider === "openai" ? "openai-api" : rawProvider;
  return { ...defaults, ...input, provider: (provider || defaults.provider) as AgentSettings["provider"] };
}

export function defaultAppSettings(workspacePath = ""): AppSettings {
  return {
    settingsSchemaVersion: 4,
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
