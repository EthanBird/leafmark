import { describe, expect, it } from "vitest";
import { normalizeAgentSettings, normalizeAppSettings, SETTINGS_SCHEMA_VERSION } from "./settings-defaults";

describe("settings normalization", () => {
  it("migrates pre-v6 settings to native WPS skills without dropping writing skills", () => {
    const settings = normalizeAppSettings({
      settingsSchemaVersion: 5,
      workspacePath: "/tmp/docs",
      agent: {
        provider: "deepseek",
        enabledSkills: ["writing", "proofread", "summarize", "structure", "not-a-skill"],
      },
    });
    expect(settings.settingsSchemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.agent.enabledSkills).toEqual([
      "writing",
      "proofread",
      "summarize",
      "structure",
      "wps-office",
      "wps-word",
      "wps-excel",
      "wps-ppt",
    ]);
  });

  it("does not re-enable WPS skills after the user turned them off on schema 6", () => {
    const settings = normalizeAppSettings({
      settingsSchemaVersion: 6,
      agent: { enabledSkills: ["writing"] },
    });
    expect(settings.agent.enabledSkills).toEqual(["writing"]);
  });

  it("still remaps the legacy OpenAI provider id", () => {
    const agent = normalizeAgentSettings({ provider: "openai", apiKey: "test" });
    expect(agent.provider).toBe("openai-api");
    expect(agent.apiKey).toBe("test");
  });
});
