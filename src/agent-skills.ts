import officeSkill from "../skills/wps-office/SKILL.md?raw";
import wordSkill from "../skills/wps-word/SKILL.md?raw";
import excelSkill from "../skills/wps-excel/SKILL.md?raw";
import pptSkill from "../skills/wps-ppt/SKILL.md?raw";

export interface AgentSkillDefinition {
  id: string;
  label: string;
  group: "writing" | "office";
  summary: string;
  body?: string;
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
}

const SHORT_SKILLS: Array<Pick<AgentSkillDefinition, "id" | "label" | "summary">> = [
  { id: "writing", label: "写作", summary: "写作：保持作者原意，改善结构、节奏、可读性与信息密度。" },
  { id: "proofread", label: "校对", summary: "校对：检查错别字、标点、病句、术语一致性与 Markdown 语法。" },
  { id: "translate", label: "翻译", summary: "翻译：忠实保留层级、链接、代码、公式和专有名词。" },
  { id: "summarize", label: "总结", summary: "总结：先给结论，再按主题提炼事实、依据和待办。" },
  { id: "structure", label: "结构化", summary: "结构化：用清晰标题、列表、表格重组内容，避免空洞层级。" },
  { id: "research", label: "研究", summary: "研究：区分已知事实、推断和待验证信息，必要时使用工具取证。" },
];

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? raw).trim();
  const name = /(?:^|\n)name:\s*(.+)/.exec(frontmatter)?.[1]?.trim() ?? "";
  const description = /(?:^|\n)description:\s*(.+)/.exec(frontmatter)?.[1]?.trim() ?? "";
  if (description.length > 1024) throw new Error(`skill ${name || "unknown"} description exceeds 1024 characters`);
  return { name, description, body };
}

function officeSkillDef(id: string, label: string, raw: string): AgentSkillDefinition {
  const parsed = parseSkillMarkdown(raw);
  return {
    id,
    label,
    group: "office",
    summary: parsed.description || parsed.name,
    body: `${parsed.description}\n\n${parsed.body}`.trim(),
  };
}

export const AGENT_SKILLS: AgentSkillDefinition[] = [
  ...SHORT_SKILLS.map((skill) => ({ ...skill, group: "writing" as const })),
  officeSkillDef("wps-office", "WPS 总控", officeSkill),
  officeSkillDef("wps-word", "WPS 文字", wordSkill),
  officeSkillDef("wps-excel", "WPS 表格", excelSkill),
  officeSkillDef("wps-ppt", "WPS 演示", pptSkill),
];

export const AGENT_SKILL_MAP = Object.fromEntries(AGENT_SKILLS.map((skill) => [skill.id, skill])) as Record<string, AgentSkillDefinition>;
export const KNOWN_AGENT_SKILL_IDS = AGENT_SKILLS.map((skill) => skill.id);
export const DEFAULT_OFFICE_SKILL_IDS = AGENT_SKILLS.filter((skill) => skill.group === "office").map((skill) => skill.id);
export const DEFAULT_ENABLED_SKILL_IDS = ["writing", "proofread", "summarize", "structure", ...DEFAULT_OFFICE_SKILL_IDS];

export function skillPromptFor(id: string, officeOpen = false) {
  const skill = AGENT_SKILL_MAP[id];
  if (!skill) return "";
  if (skill.group === "office" && !officeOpen) {
    return `${skill.label}（${skill.id}）：已启用。打开 Word / Excel / PPT 后会展开完整工作流；当前可用 inspect_office、read_office、office_execute。`;
  }
  return skill.body ? `${skill.label}（${skill.id}）\n${skill.body}` : skill.summary;
}

export function enabledSkillPrompt(ids: string[], officeOpen = false) {
  return ids.map((id) => skillPromptFor(id, officeOpen)).filter(Boolean);
}

export function normalizeEnabledSkills(ids: unknown, migrateOfficeSkills = false) {
  const known = new Set(KNOWN_AGENT_SKILL_IDS);
  const seen = new Set<string>();
  const next: string[] = [];
  const source = Array.isArray(ids) ? ids : migrateOfficeSkills ? DEFAULT_ENABLED_SKILL_IDS : [];
  for (const id of source) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  if (migrateOfficeSkills) {
    for (const id of DEFAULT_OFFICE_SKILL_IDS) {
      if (!seen.has(id)) next.push(id);
    }
  }
  return next;
}

export function suggestedMarkdownPath(content: string, now = new Date()) {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1];
  const source = (heading || content).replace(/\s+/g, " ").trim() || "agent-reply";
  const slug = source
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "agent-reply";
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `agent-replies/${stamp}-${slug}.md`;
}

export async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("当前环境无法复制");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
