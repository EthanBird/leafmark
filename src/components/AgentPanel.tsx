import {
  Bot,
  BrainCircuit,
  ChevronDown,
  FilePenLine,
  History,
  LoaderCircle,
  Plus,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Redo2,
  Wrench,
  X,
} from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  fetchWebText,
  loadMcpTools,
  runAgentTurn,
  type AgentRuntimeTool,
  type AgentToolActivity,
} from "../agent-runtime";
import {
  loadAgentMemories,
  loadAgentSessions,
  activeAgentMessages,
  agentTurnPersisted,
  discardAgentRedoBranches,
  newAgentSession,
  relevantMemoryPrompt,
  removeAgentMemory,
  removeAgentSession,
  saveAgentSession,
  searchAgentMemories,
  searchAgentSessions,
  setAgentTurnApplied,
  storeAgentMemory,
  type AgentMemory,
  type AgentSession,
} from "../agent-storage";
import type {
  AgentReasoningEffort,
  AgentSettings,
  AgentVersionOperation,
  AgentVersionStatus,
  AgentVersionSummary,
  DocumentEntry,
  DocumentOrigin,
} from "../types";
import { api } from "../api";
import { REASONING_EFFORT_LABELS, reasoningEffortsForProvider } from "../agent-providers";
import {
  beginAgentJobJournal,
  clearAgentJobJournal,
  completeAgentJobJournal,
  flushAgentJobJournal,
  loadAgentJobJournal,
  recoverAgentJobJournal,
  updateAgentJobJournal,
  type AgentJobPhase,
} from "../agent-job-journal";

export interface AgentDocumentHost {
  current: { path: string; content: string; origin: DocumentOrigin; archiveId: string } | null;
  documents: DocumentEntry[];
  readDocument: (path?: string) => Promise<string>;
  replaceCurrentDocument: (content: string) => Promise<void>;
  replaceText: (path: string | undefined, search: string, replacement: string, all: boolean) => Promise<string>;
  createDocument: (path: string, content: string) => Promise<string>;
  beginDocumentStream: (path: string | undefined, mode: AgentDocumentStreamMode) => Promise<AgentDocumentStreamHandle>;
  appendDocumentStream: (id: string, delta: string) => void;
  finishDocumentStream: (id: string) => Promise<AgentDocumentStreamResult>;
  abortDocumentStream: (id: string) => Promise<void>;
  openDocument: (path: string) => Promise<void>;
  searchDocuments: (query: string, limit: number) => Promise<Array<{ path: string; excerpt: string }>>;
  flushDocumentChanges: () => Promise<void>;
  reconcileExternalChanges: () => Promise<void>;
  beginVersionTurn: (sessionId: string, turnId: string, label: string) => Promise<void>;
  finishVersionTurn: (turnId: string, outcome: AgentVersionSummary["outcome"]) => Promise<AgentVersionSummary>;
  findVersionForTurn: (turnId: string) => Promise<AgentVersionSummary | null>;
  versionStatus: () => Promise<AgentVersionStatus>;
  undoVersion: () => Promise<AgentVersionOperation>;
  redoVersion: () => Promise<AgentVersionOperation>;
}

export type AgentDocumentStreamMode = "create" | "replace" | "append";

export interface AgentDocumentStreamHandle {
  id: string;
  path: string;
  mode: AgentDocumentStreamMode;
}

export interface AgentDocumentStreamResult extends AgentDocumentStreamHandle {
  characters: number;
  bytes: number;
}

interface AgentPanelProps {
  settings: AgentSettings;
  host: AgentDocumentHost;
  onOpenSettings: () => void;
  onReasoningEffortChange: (effort: AgentReasoningEffort) => void;
  onActivityChange: (active: boolean) => void;
}

const BUILTIN_SKILLS: Record<string, string> = {
  writing: "写作：保持作者原意，改善结构、节奏、可读性与信息密度。",
  proofread: "校对：检查错别字、标点、病句、术语一致性与 Markdown 语法。",
  translate: "翻译：忠实保留层级、链接、代码、公式和专有名词。",
  summarize: "总结：先给结论，再按主题提炼事实、依据和待办。",
  structure: "结构化：用清晰标题、列表、表格重组内容，避免空洞层级。",
  research: "研究：区分已知事实、推断和待验证信息，必要时使用工具取证。",
};

export function AgentPanel({ settings, host, onOpenSettings, onReasoningEffortChange, onActivityChange }: AgentPanelProps) {
  const initial = useMemo(() => loadAgentSessions()[0] ?? newAgentSession(), []);
  const [session, setSession] = useState<AgentSession>(initial);
  const [sessions, setSessions] = useState<AgentSession[]>(() => loadAgentSessions());
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [activities, setActivities] = useState<AgentToolActivity[]>([]);
  const [working, setWorking] = useState(false);
  const [versionBusy, setVersionBusy] = useState(false);
  const [recoveryLocked, setRecoveryLocked] = useState(false);
  const [versionStatus, setVersionStatus] = useState<AgentVersionStatus>({ undo: null, redo: null, pending: false });
  const [notice, setNotice] = useState("就绪");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<AgentMemory[]>(() => loadAgentMemories());
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const reasoningRef = useRef("");
  const activitiesRef = useRef<AgentToolActivity[]>([]);
  const recoveryStartedRef = useRef(false);

  const refreshVersionStatus = async () => {
    try { setVersionStatus(await host.versionStatus()); }
    catch { setVersionStatus({ undo: null, redo: null, pending: false }); }
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior: working ? "auto" : "smooth" });
    else element.scrollTop = element.scrollHeight;
  }, [activities, draft, session.messages, working]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    onActivityChange(false);
  }, [onActivityChange]);

  useEffect(() => {
    onActivityChange(working || versionBusy || recoveryLocked);
  }, [onActivityChange, recoveryLocked, versionBusy, working]);

  useEffect(() => {
    const flush = () => {
      try { flushAgentJobJournal(); }
      catch { /* the active request continues even if WebView storage is unavailable */ }
      void host.flushDocumentChanges().catch(() => undefined);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  useEffect(() => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    const recovered = recoverAgentJobJournal();
    if (!recovered) return;
    let cancelled = false;
    let recoveredVersionDurable = false;
    onActivityChange(true);
    setVersionBusy(true);
    setNotice("正在恢复意外中断的 Agent 回合…");
    void (async () => {
      try {
        const stored = loadAgentSessions();
        const previous = stored.find((item) => item.id === recovered.sessionId) ?? {
          id: recovered.sessionId,
          title: titleFromPrompt(recovered.prompt),
          createdAt: recovered.updatedAt,
          updatedAt: recovered.updatedAt,
          messages: [],
          cursor: 0,
        };
        const messages = activeAgentMessages(previous);
        const hasUser = messages.some((message) => message.turnId === recovered.turnId && message.role === "user");
        const existingAssistant = messages.find((message) => message.turnId === recovered.turnId && message.role === "assistant");
        const hasAssistant = Boolean(existingAssistant);
        let version: AgentVersionSummary | undefined = existingAssistant?.version;
        if (!version) {
          try { version = await host.finishVersionTurn(recovered.turnId, "interrupted"); }
          catch { /* native startup may already have recovered this pending VCS turn */ }
        }
        if (!version) version = await host.findVersionForTurn(recovered.turnId) ?? undefined;
        recoveredVersionDurable = Boolean(version);
        if (!version && recovered.phase === "preparing") {
          // The journal is written before native begin_turn. If startup finds
          // neither a pending nor completed version while still in this phase,
          // the request never received authority to mutate files.
          clearAgentJobJournal();
          try { window.LeafMarkAndroid?.completeAgentKeepAlive?.(recovered.turnId); }
          catch { /* service may already have been stopped by Android */ }
          recoveredVersionDurable = true;
          if (!cancelled) {
            setPrompt(recovered.prompt);
            setNotice("上次 Agent 请求尚未开始，原消息已放回输入框");
          }
          return;
        }
        const recoveredActivities = recovered.activities.map((activity) => activity.status === "running" ? {
          ...activity,
          status: "error" as const,
          output: activity.output || "应用进入后台后任务意外中断",
        } : activity);
        const nextMessages = hasAssistant ? messages.map((message) => (
          message.turnId === recovered.turnId && message.role === "assistant" && !message.version && version
            ? { ...message, version }
            : message
        )) : [
          ...messages,
          ...(!hasUser ? [{
            id: crypto.randomUUID(),
            turnId: recovered.turnId,
            role: "user" as const,
            content: recovered.prompt,
            createdAt: recovered.updatedAt,
          }] : []),
          {
            id: crypto.randomUUID(),
            turnId: recovered.turnId,
            role: "assistant" as const,
            content: recovered.draft.trim()
              ? `${recovered.draft}\n\n> 本轮在后台意外中断，以上内容已从本地任务日志恢复。`
              : "本轮在后台意外中断。已经发生的文件修改已交由本地版本记录恢复。",
            createdAt: Date.now(),
            reasoning: recovered.reasoning,
            activities: compactActivities(recoveredActivities),
            version,
          },
        ];
        const restoredSession: AgentSession = {
          ...previous,
          updatedAt: Date.now(),
          messages: nextMessages,
          cursor: nextMessages.length,
        };
        const nextSessions = saveAgentSession(restoredSession);
        const sessionDurable = version ? agentTurnPersisted(recovered.sessionId, recovered.turnId, version.id) : false;
        if (!version || !sessionDurable) {
          updateAgentJobJournal({ phase: "failed" });
          flushAgentJobJournal();
          throw new Error(!version
            ? "没有找到该回合的本地文件版本，恢复日志已保留以便下次重试"
            : "恢复消息未能写入本地存储，恢复日志已保留以防内容丢失");
        }
        if (!cancelled) {
          setSession(restoredSession);
          setSessions(nextSessions);
          setNotice("已恢复意外中断的回合；已生成内容和文件版本均已保留");
        }
        clearAgentJobJournal();
        try { window.LeafMarkAndroid?.completeAgentKeepAlive?.(recovered.turnId); }
        catch { /* service may already have been stopped by Android */ }
      } catch (error) {
        if (!cancelled) setNotice(`Agent 回合恢复未完成：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (!cancelled) {
          setVersionBusy(false);
          // A missing native version means a pending file snapshot may still
          // exist. Keep the document lock until startup recovery can close it.
          setRecoveryLocked(!recoveredVersionDurable);
          onActivityChange(!recoveredVersionDurable);
          await refreshVersionStatus();
          composerRef.current?.focus();
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { void refreshVersionStatus(); }, [host.documents]);

  useEffect(() => {
    if (!working) composerRef.current?.focus();
  }, [working]);

  const persist = (next: AgentSession) => {
    setSession(next);
    setSessions(saveAgentSession(next));
  };

  const applyVersionCursor = (operation: AgentVersionOperation) => {
    const next = setAgentTurnApplied(
      operation.version.sessionId,
      operation.version.turnId,
      operation.direction === "redo",
    );
    setSessions(next);
    const selected = next.find((item) => item.id === session.id);
    if (selected) setSession(selected);
  };

  const undoLatest = async () => {
    if (working || versionBusy || !versionStatus.undo) return;
    setVersionBusy(true);
    setNotice("正在回退消息与文件…");
    try {
      const operation = await host.undoVersion();
      applyVersionCursor(operation);
      setNotice(`已回退 · ${operation.version.label}`);
      await refreshVersionStatus();
    } catch (error) {
      setNotice(`回退失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVersionBusy(false);
      composerRef.current?.focus();
    }
  };

  const redoLatest = async () => {
    if (working || versionBusy || !versionStatus.redo) return;
    setVersionBusy(true);
    setNotice("正在重做消息与文件…");
    try {
      const operation = await host.redoVersion();
      applyVersionCursor(operation);
      setNotice(`已重做 · ${operation.version.label}`);
      await refreshVersionStatus();
    } catch (error) {
      setNotice(`重做失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVersionBusy(false);
      composerRef.current?.focus();
    }
  };

  const undoToVersion = async (versionId: string, originalPrompt: string) => {
    if (working || versionBusy) return;
    setVersionBusy(true);
    setNotice("正在回退到所选消息之前…");
    try {
      let found = false;
      for (let count = 0; count < 200; count += 1) {
        const status = await host.versionStatus();
        if (!status.undo) break;
        const operation = await host.undoVersion();
        applyVersionCursor(operation);
        if (operation.version.id === versionId) { found = true; break; }
      }
      if (!found) throw new Error("所选消息不在当前文档库的活动版本链上");
      setPrompt(originalPrompt);
      setNotice("已回退到所选消息之前，原消息已放回输入框");
      await refreshVersionStatus();
    } catch (error) {
      setNotice(`回退失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVersionBusy(false);
      composerRef.current?.focus();
    }
  };

  const startSession = () => {
    if (working || versionBusy) return;
    const next = newAgentSession();
    setSession(next);
    setDraft("");
    setReasoning("");
    setActivities([]);
    reasoningRef.current = "";
    activitiesRef.current = [];
  };

  const selectSession = (id: string) => {
    if (working || versionBusy) return;
    const next = loadAgentSessions().find((item) => item.id === id);
    if (next) setSession(next);
  };

  const deleteSession = () => {
    if (working || versionBusy) return;
    const next = removeAgentSession(session.id);
    setSessions(next);
    setSession(next[0] ?? newAgentSession());
  };

  const stop = () => controllerRef.current?.abort();

  const send = async (override?: string) => {
    const text = (override ?? prompt).trim();
    if (!text || working || versionBusy) return;
    const unfinished = loadAgentJobJournal();
    if (unfinished) {
      setNotice("上一个 Agent 回合的恢复记录尚未安全落盘，请重启应用完成恢复后再发送");
      return;
    }
    if (!settings.enabled) {
      setNotice("请先在设置中启用 AI Agent");
      onOpenSettings();
      return;
    }
    if (!settings.model.trim()) {
      setNotice("请先配置模型名称");
      onOpenSettings();
      return;
    }
    const controller = new AbortController();
    onActivityChange(true);
    controllerRef.current = controller;
    const turnId = crypto.randomUUID();
    const userMessage = { id: crypto.randomUUID(), turnId, role: "user" as const, content: text, createdAt: Date.now() };
    const activeMessages = activeAgentMessages(session);
    const workingSession: AgentSession = {
      ...session,
      title: activeMessages.length ? session.title : titleFromPrompt(text),
      updatedAt: Date.now(),
      messages: [...activeMessages, userMessage],
      cursor: activeMessages.length + 1,
    };
    setSession(workingSession);
    setPrompt("");
    setDraft("");
    setReasoning("");
    setActivities([]);
    reasoningRef.current = "";
    activitiesRef.current = [];
    setWorking(true);
    setNotice("正在建立本地可回退版本…");
    composerRef.current?.focus();
    let streamed = "";
    let versionStarted = false;
    let outcome: AgentVersionSummary["outcome"] = "completed";
    let assistantContent = "";
    let completedRounds = 0;
    let failureMessage = "";
    let journalStarted = false;
    let durableVersion: AgentVersionSummary | undefined;
    let sessionDurable = false;
    let keepAliveStarted = false;
    let cancellationPoll: number | null = null;
    const checkpoint = (patch: Parameters<typeof updateAgentJobJournal>[0]) => {
      if (!journalStarted) return;
      try { updateAgentJobJournal(patch); }
      catch { /* do not terminate a model request because the journal is unavailable */ }
    };
    const updateKeepAlive = (phase: string) => {
      if (!keepAliveStarted) return;
      try { window.LeafMarkAndroid?.updateAgentKeepAlive?.(turnId, phase); }
      catch { /* foreground service status is best effort */ }
    };
    try {
      const androidBridge = api.isAndroid() ? window.LeafMarkAndroid : undefined;
      if (androidBridge?.startAgentKeepAlive) {
        const error = androidBridge.startAgentKeepAlive(turnId, "正在建立可回退版本…");
        keepAliveStarted = !error;
        if (keepAliveStarted) {
          cancellationPoll = window.setInterval(() => {
            try {
              if (androidBridge.consumeAgentCancellation?.(turnId)) controller.abort();
            } catch { /* the Activity may be temporarily unavailable */ }
          }, 1_000);
        }
      }
      try {
        beginAgentJobJournal({
          sessionId: session.id,
          turnId,
          prompt: text,
          provider: settings.provider,
          model: settings.model,
          phase: "preparing",
        });
        journalStarted = true;
      } catch {
        // LocalStorage can be unavailable in restricted WebViews. The native
        // VCS and foreground service still protect file state in that case.
      }
      await host.beginVersionTurn(session.id, turnId, text);
      versionStarted = true;
      discardAgentRedoBranches();
      persist(workingSession);
      const localTools = buildTools(settings, host, workingSession, () => setMemories(loadAgentMemories()));
      let mcpTools: AgentRuntimeTool[] = [];
      if (settings.mcpServersJson.trim()) {
        setNotice("正在连接 MCP 工具…");
        checkpoint({ phase: "waiting_network" });
        updateKeepAlive("正在连接工具服务…");
        mcpTools = await loadMcpTools(settings.mcpServersJson, controller.signal);
      }
      setNotice("Agent 正在工作");
      checkpoint({ phase: "running_model" });
      updateKeepAlive("Agent 正在思考…");
      const systemPrompt = buildSystemPrompt(settings, host.current, text);
      const result = await runAgentTurn({
        settings,
        systemPrompt,
        messages: workingSession.messages,
        tools: [...localTools, ...mcpTools],
        signal: controller.signal,
        onText: (delta) => {
          streamed += delta;
          setDraft(streamed);
          checkpoint({ phase: "running_model", draft: streamed });
        },
        onReasoning: (delta) => {
          reasoningRef.current += delta;
          setReasoning(reasoningRef.current);
          setNotice("Agent 正在思考…");
          checkpoint({ phase: "running_model", reasoning: reasoningRef.current });
        },
        onPhase: (phase) => {
          setNotice(phase);
          const journalPhase: AgentJobPhase = /工具|PowerShell|命令|写入|保存/.test(phase)
            ? "running_tool"
            : /网络|连接/.test(phase) ? "waiting_network" : "running_model";
          checkpoint({ phase: journalPhase });
          updateKeepAlive(phase);
        },
        onTool: (activity) => {
          const index = activitiesRef.current.findIndex((item) => item.id === activity.id);
          const next = index < 0
            ? [...activitiesRef.current, activity]
            : activitiesRef.current.map((item, itemIndex) => itemIndex === index ? activity : item);
          activitiesRef.current = next;
          setActivities(next);
          checkpoint({ phase: activity.status === "running" ? "running_tool" : "running_model", activities: next });
          if (activity.status === "running") {
            setNotice(activity.name === "terminal_execute" ? "正在执行 PowerShell 命令…" : `正在调用 ${activity.name}…`);
          }
        },
      });
      assistantContent = result.content || streamed || "任务已完成。";
      completedRounds = result.rounds;
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
      if (!versionStarted) {
        setSession(session);
        setPrompt(text);
        setNotice(`无法启动可回退的 Agent 回合：${failureMessage}`);
        return;
      }
      outcome = controller.signal.aborted ? "interrupted" : "failed";
      checkpoint({ phase: outcome, draft: streamed, reasoning: reasoningRef.current, activities: activitiesRef.current });
      const terminalMessage = controller.signal.aborted
        ? "本轮已停止。已经发生的文件修改仍会纳入本地版本记录，可以安全回退。"
        : `本轮执行失败：${failureMessage}\n\n已经发生的文件修改仍会纳入本地版本记录。`;
      assistantContent = streamed.trim() ? `${streamed}\n\n> ${terminalMessage}` : terminalMessage;
    } finally {
      if (versionStarted) {
        checkpoint({ phase: "finalizing", draft: assistantContent || streamed, reasoning: reasoningRef.current, activities: activitiesRef.current });
        updateKeepAlive("正在保存消息与文件版本…");
        try {
          durableVersion = await host.finishVersionTurn(turnId, outcome);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failureMessage = failureMessage ? `${failureMessage}；版本提交失败：${detail}` : `版本提交失败：${detail}`;
        }
        if (!durableVersion) {
          try { durableVersion = await host.findVersionForTurn(turnId) ?? undefined; }
          catch { /* the journal remains until this can be retried at startup */ }
        }
        const assistant = {
          id: crypto.randomUUID(),
          turnId,
          role: "assistant" as const,
          content: assistantContent || "任务已结束。",
          createdAt: Date.now(),
          reasoning: reasoningRef.current,
          activities: compactActivities(activitiesRef.current),
          version: durableVersion,
        };
        const completedSession = {
          ...workingSession,
          updatedAt: Date.now(),
          messages: [...workingSession.messages, assistant],
          cursor: workingSession.messages.length + 1,
        };
        persist(completedSession);
        sessionDurable = durableVersion ? agentTurnPersisted(workingSession.id, turnId, durableVersion.id) : false;
        setDraft("");
        setReasoning("");
        setActivities([]);
        if (failureMessage) setNotice(`${outcome === "interrupted" ? "已停止" : "Agent 失败"}：${failureMessage}`);
        else if (!durableVersion || !sessionDurable) setNotice("任务已结束，但消息或文件版本尚未安全落盘；恢复记录已保留");
        else setNotice(`完成 · ${completedRounds} 轮 · ${durableVersion.changes.length} 个文件变化`);
        await refreshVersionStatus();
      }
      if (journalStarted) {
        try {
          if (!versionStarted) {
            clearAgentJobJournal();
          } else if (durableVersion && sessionDurable) {
            completeAgentJobJournal({
              draft: assistantContent || streamed,
              reasoning: reasoningRef.current,
              activities: activitiesRef.current,
            });
          } else {
            updateAgentJobJournal({
              phase: outcome === "interrupted" ? "interrupted" : "failed",
              draft: assistantContent || streamed,
              reasoning: reasoningRef.current,
              activities: activitiesRef.current,
            });
            flushAgentJobJournal();
          }
        } catch { /* a completed local session remains authoritative */ }
      }
      if (cancellationPoll !== null) window.clearInterval(cancellationPoll);
      if (keepAliveStarted) {
        try { window.LeafMarkAndroid?.completeAgentKeepAlive?.(turnId); }
        catch { /* Android may already have stopped the service */ }
      }
      controllerRef.current = null;
      setWorking(false);
      // Do not allow manual edits to become mixed into a VCS turn whose native
      // after-snapshot has not been durably finalized. The retained journal
      // will retry this recovery on the next launch.
      const needsRecoveryLock = versionStarted && !durableVersion;
      setRecoveryLocked(needsRecoveryLock);
      onActivityChange(needsRecoveryLock);
      composerRef.current?.focus();
    }
  };

  const visibleMessages = activeAgentMessages(session);
  const promptsByTurn = new Map(visibleMessages
    .filter((message) => message.role === "user" && message.turnId)
    .map((message) => [message.turnId!, message.content]));

  return (
    <section className="agent-panel" aria-label="LeafMark AI Agent">
      <header className="agent-header">
        <div className="agent-title"><span><Bot size={15} /></span><div><strong>一叶 Agent</strong><small>{settings.model || "尚未配置模型"}</small></div></div>
        <div className="agent-header-actions">
          <button type="button" onClick={() => void undoLatest()} disabled={working || versionBusy || !versionStatus.undo} title={versionStatus.undo ? `回退消息与文件：${versionStatus.undo.label}` : "没有可回退版本"}><Undo2 size={14} /></button>
          <button type="button" onClick={() => void redoLatest()} disabled={working || versionBusy || !versionStatus.redo} title={versionStatus.redo ? `重做消息与文件：${versionStatus.redo.label}` : "没有可重做版本"}><Redo2 size={14} /></button>
          <button type="button" onClick={() => setMemoryOpen((open) => !open)} title="长期记忆"><BrainCircuit size={14} /></button>
          <button type="button" onClick={startSession} title="新会话"><Plus size={15} /></button>
          <button type="button" onClick={onOpenSettings} title="Agent 设置"><Settings size={14} /></button>
        </div>
      </header>

      <div className="agent-session-bar">
        <History size={12} />
        <select value={session.id} onChange={(event) => selectSession(event.target.value)} disabled={working || versionBusy} aria-label="Agent 会话">
          {!sessions.some((item) => item.id === session.id) && <option value={session.id}>{session.title}</option>}
          {sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button type="button" onClick={deleteSession} disabled={working || versionBusy} title="删除当前会话"><Trash2 size={12} /></button>
      </div>

      {memoryOpen && (
        <div className="agent-memory-panel">
          <header><strong>长期记忆</strong><span>{memories.length} 条</span><button type="button" onClick={() => setMemoryOpen(false)}><X size={13} /></button></header>
          <div>{memories.length ? memories.slice(0, 30).map((memory) => (
            <article key={memory.id}><p>{memory.content}</p><small>{memory.tags.join(" · ") || "未分类"}</small><button type="button" onClick={() => setMemories(removeAgentMemory(memory.id))}><Trash2 size={11} /></button></article>
          )) : <p className="agent-memory-empty">Agent 会在你允许时通过 memory_store 工具保存长期信息。</p>}</div>
        </div>
      )}

      <div className="agent-messages" ref={scrollRef}>
        {!visibleMessages.length && !draft ? (
          <div className="agent-welcome">
            <span><Sparkles size={20} /></span>
            <strong>让文档自己生长</strong>
            <p>Agent 可以阅读、检索、创建和修改文档，调用记忆、Web 与 Streamable HTTP MCP 工具。</p>
            <div>
              <button type="button" onClick={() => void send("检查当前文档的结构、错别字与 Markdown 语法，只给出修改建议。")}>检查文档</button>
              <button type="button" onClick={() => void send("总结当前文档，列出核心结论与待办。")}>总结内容</button>
              <button type="button" onClick={() => void send("优化当前文档的标题层级和表达；如果允许编辑，请直接完成修改。")}>优化写作</button>
            </div>
          </div>
        ) : visibleMessages.map((message, index) => (
          <article key={`${message.createdAt}-${index}`} className={`agent-message ${message.role}`}>
            <small>{message.role === "user" ? "你" : "Agent"}</small>
            {message.role === "assistant" ? <AgentMarkdown content={message.content} /> : <p>{message.content}</p>}
            {message.reasoning && <ReasoningActivity content={message.reasoning} />}
            {message.activities?.map((activity) => <ToolActivity key={activity.id} activity={activity} />)}
            {message.role === "assistant" && message.version && <VersionActivity
              version={message.version}
              current={versionStatus.undo?.id === message.version.id}
              busy={working || versionBusy}
              onUndo={() => void undoToVersion(message.version!.id, promptsByTurn.get(message.turnId || "") || "")}
            />}
          </article>
        ))}
        {working && <div className="agent-phase"><LoaderCircle size={12} className="spin" /><span>{notice}</span></div>}
        {reasoning && <ReasoningActivity content={reasoning} streaming />}
        {activities.map((activity) => <ToolActivity key={activity.id} activity={activity} />)}
        {draft && <article className="agent-message assistant streaming"><small>Agent</small><AgentMarkdown content={draft} /><i /></article>}
      </div>

      <div className="agent-composer">
        <div className="agent-context">
          <FilePenLine size={11} />
          <span>{host.current?.path || "未选择文档"}</span>
          <label title="推理强度会随下一条消息立即生效">思考
            <select value={settings.reasoningEffort} onChange={(event) => onReasoningEffortChange(event.target.value as AgentReasoningEffort)}>
              {reasoningEffortsForProvider(settings.provider).map((effort) => <option key={effort} value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>)}
            </select>
          </label>
          <small>{notice}</small>
        </div>
        <textarea
          ref={composerRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (!working && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={working ? "可以继续输入下一条消息…" : "交给 Agent…（Shift+Enter 换行）"}
          aria-busy={working}
          rows={3}
        />
        <button className={working ? "stop" : "send"} type="button" onClick={working ? stop : () => void send()} disabled={!working && !prompt.trim()} title={working ? "停止" : "发送"}>
          {working ? <Square size={13} fill="currentColor" /> : <Send size={14} />}
        </button>
      </div>
    </section>
  );
}

function AgentMarkdown({ content }: { content: string }) {
  const deferred = useDeferredValue(content);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(deferred, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string), [deferred]);
  return <div
    className="agent-markdown"
    dangerouslySetInnerHTML={{ __html: html }}
    onClick={(event) => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor?.href) return;
      event.preventDefault();
      if (api.isTauri()) void openUrl(anchor.href);
      else window.open(anchor.href, "_blank", "noopener,noreferrer");
    }}
  />;
}

function ReasoningActivity({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <details className="agent-reasoning" open={streaming}>
    <summary>{streaming ? "正在思考" : "思考过程"}</summary>
    <AgentMarkdown content={content} />
  </details>;
}

function ToolActivity({ activity }: { activity: AgentToolActivity }) {
  const [expanded, setExpanded] = useState(activity.status === "running");
  const contentId = useId();
  const terminalCommand = activity.name === "terminal_execute" ? String(activity.input.command || "") : "";
  const status = activity.status === "running" ? "执行中" : activity.status === "done" ? "已完成" : "失败";

  // A running tool opens automatically and collapses once its status changes.
  // Afterwards the disclosure remains under the user's control even while the
  // rest of the streaming Agent panel continues to re-render.
  useEffect(() => setExpanded(activity.status === "running"), [activity.status]);

  return <section className={`agent-tool ${activity.status}`} data-expanded={expanded ? "true" : "false"}>
    <button
      type="button"
      className="agent-tool-summary"
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={() => setExpanded((open) => !open)}
    >
      {activity.status === "running" ? <LoaderCircle size={13} className="spin" /> : <Wrench size={13} />}
      <span><strong>{terminalCommand ? "PowerShell" : activity.name}</strong><small>{status}</small></span>
      <ChevronDown className="agent-tool-chevron" size={13} aria-hidden="true" />
    </button>
    <div id={contentId} className="agent-tool-content" hidden={!expanded}>
      {terminalCommand && <code className="agent-command">PS&gt; {terminalCommand}</code>}
      <div className="agent-tool-detail">
        <strong>参数</strong>
        <pre>{JSON.stringify(activity.input, null, 2)}</pre>
        {activity.output !== undefined && <><strong>结果</strong><pre>{activity.output.slice(0, 12_000)}</pre></>}
      </div>
    </div>
  </section>;
}

function VersionActivity({
  version,
  current,
  busy,
  onUndo,
}: {
  version: AgentVersionSummary;
  current: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  const outcome = version.outcome === "completed" ? "已应用" : version.outcome === "interrupted" ? "已停止但可回退" : version.outcome === "recovered" ? "崩溃后已恢复记录" : "失败但可回退";
  return <details className="agent-version">
    <summary>
      <span>{outcome} · {version.changes.length ? `${version.changes.length} 项文件变化` : "未改变文件"}</span>
      <small>本地版本</small>
    </summary>
    <div>
      {version.changes.length ? <ul>{version.changes.map((change) => <li key={`${change.kind}:${change.target}`}>
        <b>{change.kind === "created" ? "新增" : change.kind === "deleted" ? "删除" : "修改"}</b>
        <span>{change.target}</span>
      </li>)}</ul> : <p>这一轮只产生了对话内容，没有文件差异。</p>}
      <button type="button" onClick={onUndo} disabled={busy} title={current ? "回退本轮消息和全部文件" : "先回退它之后的版本，再回退本轮"}>
        <Undo2 size={12} /> {current ? "回退本轮" : "回退到这里"}
      </button>
    </div>
  </details>;
}

function compactActivities(activities: AgentToolActivity[]) {
  return activities.map((activity) => ({
    ...activity,
    output: activity.output?.slice(0, 12_000),
  }));
}

function buildSystemPrompt(settings: AgentSettings, current: AgentDocumentHost["current"], query: string) {
  const skills = settings.enabledSkills.map((skill) => BUILTIN_SKILLS[skill]).filter(Boolean);
  if (settings.customSkills.trim()) skills.push(`自定义技能：\n${settings.customSkills.trim()}`);
  const document = current
    ? `\n\n当前活动文档：${current.path}\n\n<document>\n${current.content.slice(0, settings.contextChars)}\n</document>${current.content.length > settings.contextChars ? "\n[文档内容已按上下文字符上限截断，可用 read_document 精确读取]" : ""}`
    : "\n\n当前没有打开文档。";
  return `${settings.systemPrompt.trim() || "你是一叶 LeafMark 内置的文档 Agent。先理解目标，再使用工具；修改文档前确认工具权限，保持 Markdown、公式、链接和代码完整。"}

可用能力包括多轮工具调用、文档读写与检索、会话检索、长期记忆、Web 获取和已配置的 MCP 工具。不要声称执行了未实际调用的工具。
需要新建、完整重写或续写较长 Markdown 时，优先单独调用 begin_document_output。工具就绪后的下一次回复必须只包含要写入文档的原始 Markdown，不要添加代码围栏、解释、前言或后记；该回复会直接流式进入编辑窗口。精确的小范围修改仍使用 replace_text。
本轮对当前文档库和 LeafMark 保留副本的文件修改会被记录为一个可回退版本。终端重做只恢复文件快照，不会重新执行命令；不要修改文档库以外的路径，也不要启动脱管或后台进程。
${skills.length ? `\n已启用技能：\n- ${skills.join("\n- ")}` : ""}${settings.memoryEnabled ? relevantMemoryPrompt(query) : ""}${document}`;
}

function buildTools(settings: AgentSettings, host: AgentDocumentHost, session: AgentSession, refreshMemory: () => void): AgentRuntimeTool[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: AgentRuntimeTool["execute"], exclusiveTextSink = false): AgentRuntimeTool => ({
    definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } },
    execute,
    exclusiveTextSink,
  });
  const tools: AgentRuntimeTool[] = [
    tool("read_document", "读取当前文档或文档库中的指定 Markdown。", { path: { type: "string", description: "留空读取当前文档" } }, [], async (input) => host.readDocument(stringArg(input.path))),
    tool("list_documents", "列出文档库中的 Markdown 文件。", { limit: { type: "integer", minimum: 1, maximum: 200 } }, [], async (input) => host.documents.filter((entry) => entry.kind === "file").slice(0, numberArg(input.limit, 80)).map((entry) => entry.path).join("\n") || "文档库为空"),
    tool("search_documents", "在文档库中搜索内容，返回文件名与命中片段。", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } }, ["query"], async (input) => JSON.stringify(await host.searchDocuments(stringArg(input.query), numberArg(input.limit, 10)))),
    tool("open_document", "在 LeafMark 中打开指定文档标签。", { path: { type: "string" } }, ["path"], async (input) => { await host.openDocument(stringArg(input.path)); return `已打开 ${stringArg(input.path)}`; }),
    tool("replace_current_document", "用完整 Markdown 替换当前文档。仅在已获得编辑权限时可用。", { content: { type: "string" } }, ["content"], async (input) => {
      requireEdits(settings);
      await host.replaceCurrentDocument(stringArg(input.content));
      return "当前文档已替换，自动保存队列已接管写入";
    }),
    tool("replace_text", "在当前或指定文档中精确替换文字。", {
      path: { type: "string", description: "留空操作当前文档" },
      search: { type: "string" },
      replacement: { type: "string" },
      all: { type: "boolean", description: "是否替换全部匹配" },
    }, ["search", "replacement"], async (input) => {
      requireEdits(settings);
      return host.replaceText(stringArg(input.path) || undefined, stringArg(input.search), stringArg(input.replacement), Boolean(input.all));
    }),
    tool("create_document", "在文档库中新建 Markdown，并写入内容。", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"], async (input) => {
      requireEdits(settings);
      return host.createDocument(stringArg(input.path), stringArg(input.content));
    }),
    tool("begin_document_output", "开始把下一次模型回复作为原始 Markdown 流式写入编辑窗口。必须单独调用本工具；适合新建、完整重写或续写长文档。工具就绪后下一次回复只能输出 Markdown 正文，不能再调用工具。", {
      path: { type: "string", description: "文档库相对路径；留空操作当前文档。create 模式必须提供路径" },
      mode: { type: "string", enum: ["create", "replace", "append"], description: "create 新建；replace 完整替换；append 在原文末尾续写" },
    }, ["mode"], async (input) => {
      requireEdits(settings);
      const mode = documentStreamModeArg(input.mode);
      const stream = await host.beginDocumentStream(stringArg(input.path) || undefined, mode);
      return {
        output: `已打开 ${stream.path} 的流式写入通道。下一次回复只输出原始 Markdown 正文；不要使用代码围栏，不要解释，也不要继续调用工具。`,
        textSink: {
          label: stream.path,
          onDelta: (delta) => host.appendDocumentStream(stream.id, delta),
          complete: async () => {
            const result = await host.finishDocumentStream(stream.id);
            return `已${result.mode === "create" ? "新建" : result.mode === "append" ? "续写" : "重写"}并保存 ${result.path}（${result.characters.toLocaleString()} 字，${result.bytes.toLocaleString()} B）。`;
          },
          abort: async () => host.abortDocumentStream(stream.id),
        },
      };
    }, true),
    tool("session_search", "检索以往 Agent 会话。", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"], async (input) => searchAgentSessions(stringArg(input.query), numberArg(input.limit, 8)).join("\n") || "未找到相关会话"),
  ];
  if (settings.memoryEnabled) {
    tools.push(
      tool("memory_store", "保存一条跨会话长期记忆。", { content: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, ["content"], async (input) => {
        const memory = storeAgentMemory(stringArg(input.content), stringArrayArg(input.tags));
        refreshMemory();
        return `已保存记忆 ${memory.id}`;
      }),
      tool("memory_search", "语义检索长期记忆。", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 } }, ["query"], async (input) => JSON.stringify(searchAgentMemories(stringArg(input.query), numberArg(input.limit, 6)))),
    );
  }
  if (settings.webToolsEnabled) {
    tools.push(tool("web_fetch", "读取一个 HTTP/HTTPS 网页的主要文字。", { url: { type: "string" } }, ["url"], async (input, signal) => fetchWebText(stringArg(input.url), signal)));
  }
  if (settings.terminalToolsEnabled && !api.isAndroid()) {
    tools.push(
      tool("terminal_execute", "在当前文档库内以前台方式执行终端命令。Windows 使用不显示窗口的 PowerShell；命令前后会同步磁盘并纳入本轮文件版本。禁止后台或脱管进程，以保证所有文件修改都可回退。", {
        command: { type: "string" },
        cwd: { type: "string", description: "相对文档库的工作目录，留空使用文档库根目录" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
      }, ["command"], async (input) => {
        await host.flushDocumentChanges();
        try {
          return JSON.stringify(await api.executeAgentTerminal(stringArg(input.command), {
            cwd: stringArg(input.cwd) || undefined,
            timeoutMs: numberArg(input.timeout_seconds, 120) * 1000,
            background: false,
            allowDestructive: settings.allowDestructiveTerminal,
          }));
        } finally {
          // A command that exits non-zero or times out may still have changed
          // files. Reload every open tab before another tool can overwrite it.
          await host.reconcileExternalChanges();
        }
      }),
      tool("terminal_status", "读取后台终端任务的状态与最新输出。", { job_id: { type: "string" } }, ["job_id"], async (input) => JSON.stringify(await api.getAgentTerminalStatus(stringArg(input.job_id)))),
      tool("terminal_kill", "停止由 terminal_execute 启动的后台任务。", { job_id: { type: "string" } }, ["job_id"], async (input) => JSON.stringify(await api.killAgentTerminal(stringArg(input.job_id)))),
    );
  }
  if (settings.maxParallelAgents > 0) {
    tools.push(tool("delegate_tasks", "把彼此独立的分析任务并行委派给只读子 Agent，并返回每项结果。适合多角度审阅、核查或比较方案。", {
      tasks: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
    }, ["tasks"], async (input, signal) => {
      const tasks = stringArrayArg(input.tasks).map((item) => item.trim()).filter(Boolean).slice(0, settings.maxParallelAgents);
      if (!tasks.length) throw new Error("tasks 至少需要一个非空任务");
      const currentContext = host.current
        ? `\n\n当前文档：${host.current.path}\n<document>\n${host.current.content.slice(0, settings.contextChars)}\n</document>`
        : "\n\n当前没有打开文档。";
      const results = await Promise.all(tasks.map(async (task, index) => {
        const result = await runAgentTurn({
          settings: { ...settings, maxToolRounds: 1 },
          systemPrompt: `你是一叶 Agent 的第 ${index + 1} 个只读子 Agent。独立完成分配的任务，给出紧凑、可核查的结论；不要声称修改了文件。${currentContext}`,
          messages: [{ role: "user", content: task, createdAt: Date.now() }],
          tools: [],
          signal,
          onText: () => {},
          onTool: () => {},
        });
        return `子任务 ${index + 1}：${task}\n${result.content}`;
      }));
      return results.join("\n\n---\n\n");
    }));
  }
  void session;
  return tools;
}

function requireEdits(settings: AgentSettings) {
  if (!settings.allowDocumentEdits) throw new Error("设置中尚未允许 Agent 修改文档");
}

function titleFromPrompt(prompt: string) {
  const title = prompt.replace(/\s+/g, " ").trim();
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}

function stringArg(value: unknown) { return typeof value === "string" ? value : ""; }
function documentStreamModeArg(value: unknown): AgentDocumentStreamMode {
  if (value === "create" || value === "replace" || value === "append") return value;
  throw new Error("mode 必须是 create、replace 或 append");
}
function numberArg(value: unknown, fallback: number) { return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback; }
function stringArrayArg(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
