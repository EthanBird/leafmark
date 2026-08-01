// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  activeAgentMessages,
  agentTurnPersisted,
  newAgentSession,
  relevantMemoryPrompt,
  saveAgentSession,
  searchAgentMemories,
  setAgentTurnApplied,
  storeAgentMemory,
} from "./agent-storage";

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
    session.cursor = session.messages.length;
    expect(saveAgentSession(session)[0].messages[0].content).toBe("你好");
  });

  it("verifies a terminal Agent turn with a storage read-after-write", () => {
    const session = newAgentSession();
    session.messages.push({ id: "answer", turnId: "turn", role: "assistant", content: "完成", createdAt: 1 });
    session.cursor = 1;
    expect(agentTurnPersisted(session.id, "turn")).toBe(false);
    saveAgentSession(session);
    expect(agentTurnPersisted(session.id, "turn")).toBe(true);
    expect(agentTurnPersisted(session.id, "turn", "missing-version")).toBe(false);
  });

  it("moves message history with an Agent file version and preserves redo messages", () => {
    const session = newAgentSession();
    session.messages.push(
      { id: "user", turnId: "turn-1", role: "user", content: "修改", createdAt: 1 },
      { id: "assistant", turnId: "turn-1", role: "assistant", content: "完成", createdAt: 2 },
    );
    session.cursor = 2;
    saveAgentSession(session);
    const undone = setAgentTurnApplied(session.id, "turn-1", false)[0];
    expect(activeAgentMessages(undone)).toHaveLength(0);
    expect(undone.messages).toHaveLength(2);
    const redone = setAgentTurnApplied(session.id, "turn-1", true)[0];
    expect(activeAgentMessages(redone).map((message) => message.content)).toEqual(["修改", "完成"]);
  });
});
