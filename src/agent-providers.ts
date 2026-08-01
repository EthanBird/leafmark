import type { AgentProvider, AgentReasoningEffort } from "./types";

export interface AgentProviderProfile {
  id: AgentProvider;
  name: string;
  baseUrl: string;
  model: string;
  auth: "oauth" | "api-key" | "local";
  protocol: "openai-chat" | "openai-responses" | "anthropic" | "gemini-code-assist";
}

const profile = (
  id: AgentProvider,
  name: string,
  baseUrl: string,
  model: string,
  auth: AgentProviderProfile["auth"] = "api-key",
  protocol: AgentProviderProfile["protocol"] = "openai-chat",
): AgentProviderProfile => ({ id, name, baseUrl, model, auth, protocol });

// Kept in lockstep with jcode's provider catalog. The first four entries use
// subscription/device OAuth; the remainder are native compatible profiles.
export const AGENT_PROVIDER_PROFILES: AgentProviderProfile[] = [
  profile("openai-oauth", "OpenAI · ChatGPT/Codex 订阅", "https://chatgpt.com/backend-api/codex", "gpt-5.6-sol", "oauth", "openai-responses"),
  profile("claude-oauth", "Anthropic · Claude 订阅", "https://api.anthropic.com/v1", "claude-opus-5", "oauth", "anthropic"),
  profile("gemini-oauth", "Google · Gemini Code Assist", "https://cloudcode-pa.googleapis.com", "gemini-2.5-pro", "oauth", "gemini-code-assist"),
  profile("copilot", "GitHub Copilot 订阅", "https://api.githubcopilot.com", "gpt-4.1", "oauth"),
  profile("openai-api", "OpenAI API", "https://api.openai.com/v1", "gpt-5.4-mini"),
  profile("anthropic-api", "Anthropic API", "https://api.anthropic.com/v1", "claude-sonnet-4-6", "api-key", "anthropic"),
  profile("gemini-api", "Gemini API", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"),
  profile("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-5.4-mini"),
  profile("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-v4-flash"),
  profile("opencode", "OpenCode Zen", "https://opencode.ai/zen/v1", "minimax-m2.7"),
  profile("opencode-go", "OpenCode Go", "https://opencode.ai/zen/go/v1", "kimi-k2.5"),
  profile("zai", "Z.AI", "https://api.z.ai/api/coding/paas/v4", "glm-4.5"),
  profile("kimi", "Kimi Code", "https://api.kimi.com/coding/v1", "kimi-for-coding"),
  profile("302ai", "302.AI", "https://api.302.ai/v1", "qwen3-235b-a22b-instruct-2507"),
  profile("baseten", "Baseten", "https://inference.baseten.co/v1", "zai-org/GLM-4.7"),
  profile("cortecs", "Cortecs", "https://api.cortecs.ai/v1", "kimi-k2.5"),
  profile("comtegra", "Comtegra GPU Cloud", "https://llm.comtegra.cloud/v1", "glm-51-nvfp4"),
  profile("fpt", "FPT AI Marketplace", "https://mkp-api.fptcloud.com", "GLM-5.1"),
  profile("firmware", "Firmware", "https://app.frogbot.ai/api/v1", "kimi-k2.5"),
  profile("huggingface", "Hugging Face", "https://router.huggingface.co/v1", "zai-org/GLM-4.7"),
  profile("moonshotai", "Moonshot AI", "https://api.moonshot.ai/v1", "kimi-k2.5"),
  profile("nebius", "Nebius Token Factory", "https://api.tokenfactory.nebius.com/v1", "openai/gpt-oss-120b"),
  profile("scaleway", "Scaleway", "https://api.scaleway.ai/v1", "qwen3-coder-30b-a3b-instruct"),
  profile("stackit", "STACKIT", "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1", "openai/gpt-oss-120b"),
  profile("groq", "Groq", "https://api.groq.com/openai/v1", "llama-3.1-8b-instant"),
  profile("mistral", "Mistral", "https://api.mistral.ai/v1", "devstral-medium-2507"),
  profile("perplexity", "Perplexity", "https://api.perplexity.ai", "sonar"),
  profile("togetherai", "Together AI", "https://api.together.xyz/v1", "moonshotai/Kimi-K2-Instruct"),
  profile("deepinfra", "Deep Infra", "https://api.deepinfra.com/v1/openai", "moonshotai/Kimi-K2-Instruct"),
  profile("fireworks", "Fireworks", "https://api.fireworks.ai/inference/v1", "accounts/fireworks/routers/kimi-k2p5-turbo"),
  profile("minimax", "MiniMax", "https://api.minimax.io/v1", "MiniMax-M2.7"),
  profile("xai", "xAI", "https://api.x.ai/v1", "grok-code-fast-1"),
  profile("chutes", "Chutes", "https://llm.chutes.ai/v1", ""),
  profile("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "gpt-oss-120b"),
  profile("alibaba-coding-plan", "Alibaba Cloud Coding Plan", "https://coding-intl.dashscope.aliyuncs.com/v1", "qwen3-coder-plus"),
  profile("nvidia-nim", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", "nvidia/llama-3.1-nemotron-ultra-253b-v1"),
  profile("xiaomi-mimo", "Xiaomi MiMo", "https://api.xiaomimimo.com/v1", "mimo-v2.5"),
  profile("celeris", "Celeris", "https://inference.celeris.ai/celeris-1/v1", "celeris-1"),
  profile("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", "local-model", "local"),
  profile("ollama", "Ollama", "http://127.0.0.1:11434/v1", "qwen3:8b", "local"),
  profile("custom", "自定义 OpenAI 兼容服务", "https://example.com/v1", "model-id"),
];

export const PROVIDER_DEFAULTS = Object.fromEntries(
  AGENT_PROVIDER_PROFILES.map(({ id, baseUrl, model }) => [id, { baseUrl, model }]),
) as Record<AgentProvider, { baseUrl: string; model: string }>;

export function providerProfile(provider: AgentProvider) {
  return AGENT_PROVIDER_PROFILES.find((item) => item.id === provider) ?? AGENT_PROVIDER_PROFILES.at(-1)!;
}

export function isOAuthProvider(provider: AgentProvider) {
  return providerProfile(provider).auth === "oauth";
}

export const REASONING_EFFORT_LABELS: Record<AgentReasoningEffort, string> = {
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

export function reasoningEffortsForProvider(provider: AgentProvider): AgentReasoningEffort[] {
  if (provider === "openai-oauth" || provider === "openai-api") {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (provider === "claude-oauth" || provider === "anthropic-api" || provider === "copilot") {
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }
  if (provider === "deepseek") return ["none", "low", "medium", "high", "max"];
  return ["none", "minimal", "low", "medium", "high", "xhigh"];
}

export function defaultReasoningEffort(provider: AgentProvider): AgentReasoningEffort {
  if (provider === "openai-oauth") return "low";
  return "none";
}
