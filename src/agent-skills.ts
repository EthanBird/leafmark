export type BuiltinSkillGroup = "writing" | "office";

export interface BuiltinSkill {
  id: string;
  label: string;
  group: BuiltinSkillGroup;
  /** Always injected when the skill is enabled. Keep this trigger-specific and short. */
  summary: string;
  /** If the query or current path matches, the full playbook is appended. */
  triggers: RegExp;
  playbook?: string;
}

const SLIDES_PLAYBOOK = `做演示稿时按「先理解、再大纲、再逐页排版、最后自检」执行，不要把长文直接拆成条目列表。

1. 先通读材料，记下叙事弧（问题→方法→证据→结论，或等价结构）以及值得单独成页的数字、图、表。未读完前不要写页。
2. 先写出 8–15 页大纲（可随材料增减）：每页只承担一个论点。标题页、问题、方法、证据、结论分开。把大纲写成文档库中的 outline.md，确认结构后再写正文。
3. 画布按 16:9 来想（约 1280×720）。一页不超过 6 条要点、正文尽量压在 150 字以内；数字抽成独立强调，不要埋在段落里。
4. 版式在同一套主题里轮换，不要每页都是「大标题+项目符号」：
   - 标题页：大标题 + 副标题/场合/日期
   - 论点页：短标题 + 3–5 条
   - 左右分栏：左文右图或左数字右解释
   - 全图/表：图为主，一句图注
   - 网格：2×2 或三列对比
   禁止套用通用紫渐变白底模板，禁止中英混排口号，禁止一页塞进多个互不相关的主题。
5. 语言跟材料走：中文材料用中文页，英文材料用英文页。中文用系统黑体/宋体思路排，不要用无法覆盖汉字的西文装饰字体冒充中文。
6. 在一叶中的交付物：
   - 默认写一份 Markdown 演示稿，用 --- 分页，每页以二级标题开头，可附 Mermaid 图。
   - 需要浏览器演示时，再写独立 HTML 页：单文件、内嵌 CSS、overflow:hidden、页脚保留演示标题和页码；图用相对路径。
   - 不要声称已生成真正的 .pptx，除非用户明确只要大纲或 HTML 预览。
7. 自检：每页一个论点；无溢出感；主题色/字号/间距全套一致；图有图注；有页码；outline 与最终页数一致。`;

const OFFICE_WORD_PLAYBOOK = `写正式文稿（报告、合同、简历、公文、试卷）时，先判场景再排版，不要用博客口吻或空标题堆砌。

场景路由：
- 学术/论文：摘要→方法→结果→讨论；术语稳定；公式保持 LaTeX。
- 报告/方案：结论先行，再用标题/列表/表格承载证据。
- 合同/协议：定义→标的→权利义务→违约→争议；用完整句子，不用口号。
- 简历：一页优先；经历用动词+结果；日期右齐。
- 公文/通知：发文结构清楚，称呼、事项、落款、日期齐全。
- 试卷/讲义：题号连续，预留作答空间，答案与题目分离。

中文排版：正文两端对齐、首行缩进两字；默认约 1.3 倍行距；标题层级不超过四级；表有表头且单元格不拆行；图保持比例，不写死宽高。封面只用简单稳定的结构（标题/副标题/作者/日期/单位），不要手绘复杂封面。

在一叶中写成结构完整的 Markdown。需要 Word 兼容时，用标准标题、表格和列表，避免 HTML 花样。写完后自检：场景是否匹配、术语是否一致、表图是否有标题、有无空层级。`;

const OFFICE_PDF_PLAYBOOK = `按成品类型选路线，不要一律生成长滚动网页再假装成 PDF。

- 长文报告/合同/白皮书：结构化分页，目录、页码、标题层级稳定；表格可跨页时重复表头。
- 海报/邀请函/一页视觉件：按单页构图，正文预算约 150 字；大数字、短标题、留白；不要把报告正文灌进海报。
- 学术/公式：公式保持 LaTeX；图表单独编号。
- 已有 PDF：先提取/理解，再决定是摘录、重排还是做成演示。

中日韩正文必须落到能覆盖汉字的字体思路上。视觉页避免溢出：固定画布、禁止无界长段落、长词要能断行。一叶默认导出 Markdown→PDF/PNG，因此先保证 Markdown 结构干净；用户要「一页一张图」时按页拆分，不要生成一张超长海报却声称已分页。`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: "writing",
    label: "写作",
    group: "writing",
    summary: "写作：保持作者原意，改善结构、节奏、可读性与信息密度。",
    triggers: /写作|润色|改写|扩写|rewrite|edit copy/i,
  },
  {
    id: "proofread",
    label: "校对",
    group: "writing",
    summary: "校对：检查错别字、标点、病句、术语一致性与 Markdown 语法。",
    triggers: /校对|错别字|病句|proofread|typo/i,
  },
  {
    id: "translate",
    label: "翻译",
    group: "writing",
    summary: "翻译：忠实保留层级、链接、代码、公式和专有名词。",
    triggers: /翻译|translate|中译英|英译中/i,
  },
  {
    id: "summarize",
    label: "总结",
    group: "writing",
    summary: "总结：先给结论，再按主题提炼事实、依据和待办。",
    triggers: /总结|摘要|summar/i,
  },
  {
    id: "structure",
    label: "结构化",
    group: "writing",
    summary: "结构化：用清晰标题、列表、表格重组内容，避免空洞层级。",
    triggers: /结构化|大纲|目录|restructur/i,
  },
  {
    id: "research",
    label: "研究",
    group: "writing",
    summary: "研究：区分已知事实、推断和待验证信息，必要时使用工具取证。",
    triggers: /研究|查证|引用|research|source/i,
  },
  {
    id: "slides",
    label: "幻灯片",
    group: "office",
    summary: "幻灯片：做 PPT、路演、答辩或把文档改成演示稿时使用。先写大纲再逐页排版，禁止把长文直接塞进条目。",
    triggers: /ppt|pptx|幻灯|演示|路演|答辩|pitch|deck|slides?|beamer|keynote|presentation/i,
    playbook: SLIDES_PLAYBOOK,
  },
  {
    id: "office-word",
    label: "文稿",
    group: "office",
    summary: "文稿：写报告、合同、简历、公文或试卷时使用。先判场景，再按中文正式文稿习惯排版。",
    triggers: /(\.docx?\b)|word文档|正式文稿|合同|简历|公文|通知|试卷|proposal|contract|resume|\bcv\b/i,
    playbook: OFFICE_WORD_PLAYBOOK,
  },
  {
    id: "office-pdf",
    label: "版式",
    group: "office",
    summary: "版式：做正式 PDF、海报或需要严格分页的成品时使用。按报告/视觉页/学术三条路线处理，并防止溢出。",
    triggers: /pdf|海报|邀请函|白皮书|poster|infographic|a4|分页/i,
    playbook: OFFICE_PDF_PLAYBOOK,
  },
];

export const BUILTIN_SKILL_GROUPS: Array<{ id: BuiltinSkillGroup; label: string }> = [
  { id: "writing", label: "写作" },
  { id: "office", label: "办公" },
];

const skillsById = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]));

export function builtinSkill(id: string): BuiltinSkill | undefined {
  return skillsById.get(id);
}

export function skillIsTriggered(skill: BuiltinSkill, query: string, documentPath = ""): boolean {
  const haystack = `${query}\n${documentPath}`;
  return skill.triggers.test(haystack);
}

export function buildEnabledSkillPrompt(
  enabledIds: string[],
  customSkills: string,
  query = "",
  documentPath = "",
): string {
  const enabled = enabledIds.map((id) => skillsById.get(id)).filter((skill): skill is BuiltinSkill => Boolean(skill));
  const lines = enabled.map((skill) => skill.summary);
  const trimmedCustom = customSkills.trim();
  if (trimmedCustom) lines.push(`自定义技能：\n${trimmedCustom}`);
  if (!lines.length) return "";

  const playbooks = enabled.filter((skill) => skill.playbook && skillIsTriggered(skill, query, documentPath));
  const playbookBlock = playbooks.length
    ? `\n\n当前任务匹配到完整工作法：\n${playbooks.map((skill) => `### ${skill.label}\n${skill.playbook}`).join("\n\n")}`
    : "";
  return `\n已启用技能：\n- ${lines.join("\n- ")}${playbookBlock}`;
}
