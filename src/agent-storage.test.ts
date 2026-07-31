// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { newAgentSession, relevantMemoryPrompt, saveAgentSession, searchAgentMemories, storeAgentMemory } from "./agent-storage";

describe("lightweight agent storage", () => {
  beforeEach(() => localStorage.clear());

  it("ranks Chinese memories without loading an embedding model", () => {
    storeAgentMemory("用户偏好一叶绿的深色主题", ["主题"]);
    storeAgentMemory("PDF 导出必须保留可复制文字", ["导出"]);
    expect(searchAgentMemories("深色配色", 1)[0].content).toContain("一叶绿");
    expect(relevantMemoryPrompt("PDF 文字")).toContain("可复制文字");
  });

  it("persists resumable sessions", () => {
    const session = newAgentSession();
    session.title = "测试会话";
    session.messages.push({ role: "user", content: "你好", createdAt: Date.now() });
    expect(saveAgentSession(session)[0].messages[0].content).toBe("你好");
  });
});
