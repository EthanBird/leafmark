import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, enabledSkillPrompt, normalizeEnabledSkills, parseSkillMarkdown, suggestedMarkdownPath } from "./agent-skills";
import { askAiToolbarPosition, buildAskAiPrompt } from "./ask-ai";
import { parseOfficeMutation } from "./office/office-agent";

describe("agent skills", () => {
  it("parses ZCode-style SKILL.md frontmatter within the 1024-character description limit", () => {
    for (const skill of AGENT_SKILLS.filter((item) => item.group === "office")) {
      expect(skill.id.startsWith("wps-")).toBe(true);
      expect(skill.summary.length).toBeGreaterThan(8);
      expect(skill.summary.length).toBeLessThanOrEqual(1024);
      expect(skill.body).toContain("office_execute");
      expect(skill.body).toMatch(/inspect_office|wordFindReplace|sheetEdit|slideText/);
    }
    const parsed = parseSkillMarkdown("---\nname: demo\ndescription: 用于测试的技能说明。\n---\n\n# Demo\nbody");
    expect(parsed).toMatchObject({ name: "demo", description: "用于测试的技能说明。", body: "# Demo\nbody" });
  });

  it("injects compact office skill hints until an Office document is open", () => {
    const compact = enabledSkillPrompt(["writing", "wps-word"]).join("\n");
    expect(compact).toContain("写作");
    expect(compact).toContain("wps-word");
    expect(compact).not.toContain("wordFindReplace");
    const expanded = enabledSkillPrompt(["wps-word"], true).join("\n");
    expect(expanded).toContain("wordFindReplace");
  });

  it("filters unknown skills and can migrate missing WPS skills", () => {
    expect(normalizeEnabledSkills(["writing", "unknown", "writing"])).toEqual(["writing"]);
    expect(normalizeEnabledSkills(["writing"], true)).toEqual(["writing", "wps-office", "wps-word", "wps-excel", "wps-ppt"]);
    expect(normalizeEnabledSkills([])).toEqual([]);
  });

  it("builds a timestamped markdown path from an agent reply", () => {
    expect(suggestedMarkdownPath("# 周报\n\n结论", new Date("2026-08-18T11:03:04Z"))).toMatch(/^agent-replies\/\d{8}-\d{6}-周报\.md$/);
  });
});

describe("划词问 AI", () => {
  it("wraps the selected excerpt with an intent and source citation", () => {
    const prompt = buildAskAiPrompt({ text: "秒开本地文档", path: "说明.docx", kind: "word", location: "第 2 段" }, "explain");
    expect(prompt).toContain("<excerpt>\n秒开本地文档\n</excerpt>");
    expect(prompt).toContain("文档：说明.docx");
    expect(prompt).toContain("位置：第 2 段");
    expect(prompt).toContain("解释");
    expect(askAiToolbarPosition({ left: 20, bottom: 40 } as DOMRect, { width: 800, height: 600 })).toEqual({ x: 20, y: 46 });
  });
});

describe("office mutation parser", () => {
  it("accepts documented Word / Excel / PPT operations and rejects unknown ops", () => {
    expect(parseOfficeMutation({ op: "wordFindReplace", query: "旧", replacement: "新" })).toEqual({
      op: "wordFindReplace",
      query: "旧",
      replacement: "新",
      all: true,
    });
    expect(parseOfficeMutation({ op: "sheetEdit", name: "Sheet1", row: 0, col: 1, input: "=A1" })).toMatchObject({
      op: "sheetEdit",
      name: "Sheet1",
      input: "=A1",
    });
    expect(parseOfficeMutation({ op: "slideNotes", index: 0, notes: "讲稿" })).toEqual({
      op: "slideNotes",
      index: 0,
      notes: "讲稿",
    });
    expect(() => parseOfficeMutation({ op: "wps_office_execute", code: "Application.Run" })).toThrow("不支持的 office op");
    const runStyle = parseOfficeMutation({ op: "wordRunStyle", index: 0, style: { bold: true } });
    expect(runStyle).toMatchObject({ op: "wordRunStyle", index: 0 });
    if (runStyle.op !== "wordRunStyle") throw new Error("expected wordRunStyle");
    expect(runStyle.style.bold).toBe(true);
    expect(runStyle.style.text).toBeUndefined();
  });
});
