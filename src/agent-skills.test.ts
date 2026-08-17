import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  buildEnabledSkillPrompt,
  builtinSkill,
  skillIsTriggered,
} from "./agent-skills";
import { defaultAgentSettings } from "./settings-defaults";

describe("agent skills", () => {
  it("keeps writing skills as short summaries and office skills as on-demand playbooks", () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.id)).toEqual([
      "writing",
      "proofread",
      "translate",
      "summarize",
      "structure",
      "research",
      "slides",
      "office-word",
      "office-pdf",
    ]);
    expect(builtinSkill("slides")?.playbook).toContain("先通读材料");
    expect(builtinSkill("writing")?.playbook).toBeUndefined();
  });

  it("enables slides by default but only injects the short description until a deck task appears", () => {
    const settings = defaultAgentSettings();
    expect(settings.enabledSkills).toContain("slides");
    const idle = buildEnabledSkillPrompt(settings.enabledSkills, "", "优化当前文档的标题层级");
    expect(idle).toContain("幻灯片：做 PPT");
    expect(idle).not.toContain("当前任务匹配到完整工作法");
    expect(idle).not.toContain("先通读材料");
  });

  it("loads the slides playbook for PPT requests and existing presentation files", () => {
    expect(skillIsTriggered(builtinSkill("slides")!, "根据这份年报做一套路演PPT")).toBe(true);
    expect(skillIsTriggered(builtinSkill("slides")!, "校对错别字", "季度汇报.pptx")).toBe(true);
    const prompt = buildEnabledSkillPrompt(
      ["slides"],
      "",
      "把当前文档改成答辩幻灯片",
      "开题.md",
    );
    expect(prompt).toContain("当前任务匹配到完整工作法");
    expect(prompt).toContain("### 幻灯片");
    expect(prompt).toContain("用 --- 分页");
    expect(prompt).toContain("不要声称已生成真正的 .pptx");
  });

  it("does not leak office playbooks when those skills are disabled", () => {
    const prompt = buildEnabledSkillPrompt(["writing"], "", "请做一份 PPT");
    expect(prompt).toContain("写作：保持作者原意");
    expect(prompt).not.toContain("### 幻灯片");
  });

  it("appends custom skills without treating them as a playbook trigger", () => {
    const prompt = buildEnabledSkillPrompt(["research"], "公式必须保持 LaTeX 原文。", "随便问问");
    expect(prompt).toContain("自定义技能：\n公式必须保持 LaTeX 原文。");
    expect(prompt).not.toContain("当前任务匹配到完整工作法");
  });
});
