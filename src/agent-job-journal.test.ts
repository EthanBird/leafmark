// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_JOB_JOURNAL_KEY,
  beginAgentJobJournal,
  clearAgentJobJournal,
  completeAgentJobJournal,
  flushAgentJobJournal,
  loadAgentJobJournal,
  recoverAgentJobJournal,
  updateAgentJobJournal,
} from "./agent-job-journal";

describe("active Agent turn journal", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearAgentJobJournal();
  });

  it("persists every field required to recover a turn", () => {
    const started = beginAgentJobJournal({
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "测试任务",
      provider: "openai-oauth",
      model: "gpt-5.3-codex",
      phase: "running_model",
      draft: "一",
      reasoning: "检查结构",
      activities: [{ id: "call-1", name: "read_document", input: {}, status: "running" }],
    });

    expect(started.seq).toBe(1);
    expect(loadAgentJobJournal()).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "测试任务",
      phase: "running_model",
      draft: "一",
      reasoning: "检查结构",
      provider: "openai-oauth",
      model: "gpt-5.3-codex",
      seq: 1,
    });
    expect(loadAgentJobJournal()?.activities[0].name).toBe("read_document");
  });

  it("throttles small updates for 250 ms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    beginAgentJobJournal({ sessionId: "s", turnId: "t", prompt: "test", provider: "openai-api", model: "gpt" });

    vi.advanceTimersByTime(20);
    updateAgentJobJournal({ draft: "small delta" });
    expect(loadAgentJobJournal()?.draft).toBe("");
    vi.advanceTimersByTime(229);
    expect(loadAgentJobJournal()?.draft).toBe("");
    vi.advanceTimersByTime(1);
    expect(loadAgentJobJournal()).toMatchObject({ draft: "small delta", seq: 2 });
  });

  it("flushes immediately when the staged snapshot grows by 2 KiB", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    beginAgentJobJournal({ sessionId: "s", turnId: "t", prompt: "test", provider: "claude-oauth", model: "claude" });

    vi.advanceTimersByTime(10);
    updateAgentJobJournal({ draft: "叶".repeat(700) });
    expect(loadAgentJobJournal()?.draft).toHaveLength(700);
  });

  it("supports lifecycle flush and reload recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    beginAgentJobJournal({ sessionId: "s", turnId: "t", prompt: "test", provider: "gemini-oauth", model: "gemini" });
    vi.advanceTimersByTime(5);
    updateAgentJobJournal({ phase: "running_tool", draft: "partial" });

    expect(flushAgentJobJournal()?.seq).toBe(2);
    expect(recoverAgentJobJournal()).toMatchObject({
      sessionId: "s",
      turnId: "t",
      phase: "running_tool",
      draft: "partial",
      seq: 2,
    });
  });

  it("completes synchronously and clears the active journal", () => {
    beginAgentJobJournal({ sessionId: "s", turnId: "t", prompt: "test", provider: "copilot", model: "gpt" });
    const completed = completeAgentJobJournal({ draft: "done", reasoning: "finished" });

    expect(completed).toMatchObject({ phase: "completed", draft: "done", reasoning: "finished", seq: 2 });
    expect(loadAgentJobJournal()).toBeNull();
    expect(localStorage.getItem(AGENT_JOB_JOURNAL_KEY)).toBeNull();
  });

  it("does not overwrite an unrelated unfinished turn", () => {
    beginAgentJobJournal({ sessionId: "s", turnId: "first", prompt: "first", provider: "custom", model: "local" });
    expect(() => beginAgentJobJournal({
      sessionId: "s",
      turnId: "second",
      prompt: "second",
      provider: "custom",
      model: "local",
    })).toThrow(/still active/);
    expect(loadAgentJobJournal()?.turnId).toBe("first");
  });

  it("rejects malformed durable snapshots during recovery", () => {
    localStorage.setItem(AGENT_JOB_JOURNAL_KEY, JSON.stringify({ turnId: "broken" }));
    expect(recoverAgentJobJournal()).toBeNull();
  });
});
