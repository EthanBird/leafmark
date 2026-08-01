import { describe, expect, it } from "vitest";
import { AGENT_PROVIDER_PROFILES, defaultReasoningEffort, isOAuthProvider, providerProfile, reasoningEffortsForProvider } from "./agent-providers";
import { normalizeAgentSettings } from "./settings-defaults";

describe("agent provider catalog", () => {
  it("keeps all jcode OpenAI-compatible profiles and native subscription routes", () => {
    expect(AGENT_PROVIDER_PROFILES.length).toBeGreaterThanOrEqual(40);
    expect(isOAuthProvider("openai-oauth")).toBe(true);
    expect(isOAuthProvider("claude-oauth")).toBe(true);
    expect(providerProfile("gemini-oauth").protocol).toBe("gemini-code-assist");
    expect(providerProfile("alibaba-coding-plan").baseUrl).toContain("dashscope.aliyuncs.com");
  });

  it("migrates the legacy OpenAI API provider id without losing settings", () => {
    const normalized = normalizeAgentSettings({ provider: "openai", apiKey: "test", terminalToolsEnabled: true });
    expect(normalized.provider).toBe("openai-api");
    expect(normalized.apiKey).toBe("test");
    expect(normalized.terminalToolsEnabled).toBe(true);
  });

  it("matches jcode's complete OpenAI reasoning ladder", () => {
    expect(reasoningEffortsForProvider("openai-oauth")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(defaultReasoningEffort("openai-oauth")).toBe("low");
  });
});
