import type { DocumentKind } from "./types";

export const ASK_AI_EVENT = "leafmark:ask-ai";
export const OPEN_AGENT_EVENT = "leafmark:open-agent";
export const OFFICE_MUTATED_EVENT = "leafmark:office-mutated";

export type AskAiIntent = "explain" | "rewrite" | "translate" | "summarize" | "ask";

export interface AskAiSelection {
  text: string;
  path?: string;
  location?: string;
  kind?: DocumentKind;
}

export interface AskAiEventDetail {
  prompt: string;
}

export interface OfficeMutatedEventDetail {
  key: string;
}

export const ASK_AI_INTENTS: Array<{ id: AskAiIntent; label: string; title: string }> = [
  { id: "explain", label: "解释", title: "解释选中文字" },
  { id: "rewrite", label: "改写", title: "改写选中文字" },
  { id: "translate", label: "翻译", title: "翻译选中文字" },
  { id: "summarize", label: "总结", title: "总结选中文字" },
  { id: "ask", label: "问 AI", title: "把选中文字交给 Agent" },
];

const INTENT_INSTRUCTIONS: Record<AskAiIntent, string> = {
  explain: "请解释下列摘录的含义、术语、逻辑和可能的歧义。先给简要结论，再补充必要背景。不要修改原文，除非用户明确要求。",
  rewrite: "请改写下列摘录，保持原意、事实和专有名词，使表达更清晰、更适合放回原文。给出改写稿；若有几种语气，选最克制的一种。",
  translate: "请翻译下列摘录。若原文主要是中文，译为流畅英文；否则译为流畅中文。保留数字、链接、公式和专有名词。",
  summarize: "请总结下列摘录。先给三句以内的结论，再列出要点与待核实处。",
  ask: "请阅读下列摘录并回答其中的问题；若摘录本身不是问句，请解释要点并给出可执行建议。不要声称已改写未打开的文件。",
};

export function buildAskAiPrompt(selection: AskAiSelection, intent: AskAiIntent = "ask") {
  const text = selection.text.trim();
  if (!text) throw new Error("没有可提问的文字");
  const excerpt = text.length > 12_000 ? `${text.slice(0, 12_000)}\n…[摘录已截断]` : text;
  const where = [
    selection.path ? `文档：${selection.path}` : "",
    selection.kind ? `类型：${selection.kind}` : "",
    selection.location ? `位置：${selection.location}` : "",
  ].filter(Boolean).join(" · ");
  return `${INTENT_INSTRUCTIONS[intent]}

${where ? `${where}\n` : ""}<excerpt>
${excerpt}
</excerpt>`;
}

export function dispatchOpenAgent() {
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_EVENT));
}

export function dispatchAskAi(prompt: string) {
  dispatchOpenAgent();
  window.dispatchEvent(new CustomEvent(ASK_AI_EVENT, { detail: { prompt } }));
}

export function askAiAbout(selection: AskAiSelection, intent: AskAiIntent = "ask") {
  dispatchAskAi(buildAskAiPrompt(selection, intent));
}

export function selectionInside(root: EventTarget | null) {
  if (!(root instanceof Element)) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const anchor = selection.anchorNode;
  if (!anchor || !root.contains(anchor)) return null;
  if (anchor instanceof Element && ignoreAskAiTarget(anchor)) return null;
  if (anchor.parentElement && ignoreAskAiTarget(anchor.parentElement)) return null;
  const text = selection.toString().replace(/\u00a0/g, " ").trim();
  if (text.length < 2) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { text, rect };
}

export function ignoreAskAiTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(".ask-ai-toolbar, .agent-panel, .office-ribbon"));
}

export function askAiToolbarPosition(rect: DOMRect, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  const width = 280;
  const height = 40;
  return {
    x: Math.max(8, Math.min(rect.left, viewport.width - width - 8)),
    y: Math.max(8, Math.min(rect.bottom + 6, viewport.height - height - 8)),
  };
}

export function dispatchOfficeMutated(key: string) {
  window.dispatchEvent(new CustomEvent(OFFICE_MUTATED_EVENT, { detail: { key } }));
}
