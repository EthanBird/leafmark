import type { AgentToolActivity } from "./agent-runtime";
import type { AgentProvider } from "./types";

export const AGENT_JOB_JOURNAL_KEY = "leafmark.agent.active-turn.v1";
export const AGENT_JOB_JOURNAL_SCHEMA_VERSION = 1;
export const AGENT_JOB_JOURNAL_THROTTLE_MS = 250;
export const AGENT_JOB_JOURNAL_SIZE_THRESHOLD_BYTES = 2 * 1024;
const MAX_JOURNAL_DRAFT_CHARS = 1_000_000;
const MAX_JOURNAL_REASONING_CHARS = 250_000;
const MAX_JOURNAL_ACTIVITIES = 80;
const MAX_ACTIVITY_OUTPUT_CHARS = 16_000;

export type AgentJobPhase =
  | "preparing"
  | "running_model"
  | "running_tool"
  | "waiting_network"
  | "waiting_user"
  | "finalizing"
  | "cancelling"
  | "completed"
  | "failed"
  | "interrupted";

const AGENT_JOB_PHASES = new Set<AgentJobPhase>([
  "preparing",
  "running_model",
  "running_tool",
  "waiting_network",
  "waiting_user",
  "finalizing",
  "cancelling",
  "completed",
  "failed",
  "interrupted",
]);

/**
 * The single active Agent turn. LeafMark's native VCS currently permits one
 * pending turn per workspace, so a single journal is intentional. Credentials
 * and full settings are deliberately excluded from this browser-side record.
 */
export interface AgentJobJournal {
  schemaVersion: typeof AGENT_JOB_JOURNAL_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  prompt: string;
  phase: AgentJobPhase;
  draft: string;
  reasoning: string;
  activities: AgentToolActivity[];
  provider: AgentProvider;
  model: string;
  updatedAt: number;
  /** Monotonically increasing snapshot revision for foreground rehydration. */
  seq: number;
}

export interface BeginAgentJobJournalInput {
  sessionId: string;
  turnId: string;
  prompt: string;
  provider: AgentProvider;
  model: string;
  phase?: AgentJobPhase;
  draft?: string;
  reasoning?: string;
  activities?: AgentToolActivity[];
}

export type AgentJobJournalPatch = Partial<Pick<
  AgentJobJournal,
  "phase" | "draft" | "reasoning" | "activities" | "provider" | "model"
>>;

let currentJournal: AgentJobJournal | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistedAt = 0;
let pendingGrowthBytes = 0;

/** Begin a new turn and synchronously persist its initial checkpoint. */
export function beginAgentJobJournal(input: BeginAgentJobJournalInput): AgentJobJournal {
  const sessionId = input.sessionId.trim();
  const turnId = input.turnId.trim();
  if (!sessionId || !turnId) throw new Error("Agent journal requires sessionId and turnId");

  const existing = loadAgentJobJournal();
  if (existing) {
    if (existing.turnId !== turnId) {
      throw new Error(`Agent turn ${existing.turnId} is still active`);
    }
    // A duplicate begin for the same durable turn can happen after WebView
    // recreation. Recover it instead of erasing already streamed content.
    return recoverAgentJobJournal()!;
  }

  cancelScheduledFlush();
  currentJournal = {
    schemaVersion: AGENT_JOB_JOURNAL_SCHEMA_VERSION,
    sessionId,
    turnId,
    prompt: truncateJournalText(input.prompt, 64_000),
    phase: input.phase ?? "preparing",
    draft: truncateJournalText(input.draft ?? "", MAX_JOURNAL_DRAFT_CHARS),
    reasoning: truncateJournalText(input.reasoning ?? "", MAX_JOURNAL_REASONING_CHARS),
    activities: normalizeActivities(input.activities ?? []),
    provider: input.provider,
    model: input.model,
    updatedAt: Date.now(),
    seq: 1,
  };
  persistCurrentJournal();
  return cloneJournal(currentJournal);
}

/**
 * Stage a new snapshot. Small updates are written at most once per 250 ms;
 * growth of 2 KiB or more bypasses the timer to bound crash-time data loss.
 */
export function updateAgentJobJournal(patch: AgentJobJournalPatch): AgentJobJournal {
  const journal = currentJournal ?? recoverAgentJobJournal();
  if (!journal) throw new Error("No active Agent turn journal");

  const nextDraft = patch.draft === undefined ? journal.draft : truncateJournalText(patch.draft, MAX_JOURNAL_DRAFT_CHARS);
  const nextReasoning = patch.reasoning === undefined ? journal.reasoning : truncateJournalText(patch.reasoning, MAX_JOURNAL_REASONING_CHARS);
  const nextActivities = patch.activities ? normalizeActivities(patch.activities) : journal.activities;
  pendingGrowthBytes += estimateStringGrowth(journal.draft, nextDraft)
    + estimateStringGrowth(journal.reasoning, nextReasoning)
    + (patch.activities ? byteLength(JSON.stringify(nextActivities)) : 0)
    + (patch.phase || patch.provider || patch.model ? 128 : 0);

  currentJournal = {
    ...journal,
    ...patch,
    draft: nextDraft,
    reasoning: nextReasoning,
    activities: nextActivities,
    updatedAt: Date.now(),
    seq: journal.seq + 1,
  };

  const elapsed = Date.now() - lastPersistedAt;
  if (
    elapsed >= AGENT_JOB_JOURNAL_THROTTLE_MS
    || pendingGrowthBytes >= AGENT_JOB_JOURNAL_SIZE_THRESHOLD_BYTES
  ) {
    persistCurrentJournal();
  } else {
    scheduleFlush(AGENT_JOB_JOURNAL_THROTTLE_MS - Math.max(0, elapsed));
  }
  return cloneJournal(currentJournal);
}

/** Immediately persist staged deltas, for visibility/page lifecycle hooks. */
export function flushAgentJobJournal(): AgentJobJournal | null {
  if (!currentJournal) return null;
  persistCurrentJournal();
  return cloneJournal(currentJournal);
}

/** Read and validate the durable snapshot without changing runtime state. */
export function loadAgentJobJournal(): AgentJobJournal | null {
  let raw: string | null;
  try {
    raw = journalStorage().getItem(AGENT_JOB_JOURNAL_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validJournal(parsed) ? cloneJournal(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Rehydrate the in-memory scheduler after a reload. Any unflushed prior JS
 * state is intentionally discarded in favour of the last durable snapshot.
 */
export function recoverAgentJobJournal(): AgentJobJournal | null {
  cancelScheduledFlush();
  const recovered = loadAgentJobJournal();
  currentJournal = recovered ? cloneJournal(recovered) : null;
  lastPersistedAt = recovered?.updatedAt ?? 0;
  pendingGrowthBytes = 0;
  return recovered ? cloneJournal(recovered) : null;
}

/**
 * Persist a terminal checkpoint synchronously, then remove the active record.
 * Call this only after the assistant message and native VCS version are durable.
 */
export function completeAgentJobJournal(
  patch: AgentJobJournalPatch = {},
): AgentJobJournal | null {
  const journal = currentJournal ?? recoverAgentJobJournal();
  if (!journal) return null;
  currentJournal = {
    ...journal,
    ...patch,
    phase: "completed",
    draft: patch.draft === undefined ? journal.draft : truncateJournalText(patch.draft, MAX_JOURNAL_DRAFT_CHARS),
    reasoning: patch.reasoning === undefined ? journal.reasoning : truncateJournalText(patch.reasoning, MAX_JOURNAL_REASONING_CHARS),
    activities: patch.activities ? normalizeActivities(patch.activities) : journal.activities,
    updatedAt: Date.now(),
    seq: journal.seq + 1,
  };
  // Make the terminal state observable if removal fails halfway through.
  persistCurrentJournal();
  const completed = cloneJournal(currentJournal);
  removeDurableJournal();
  resetRuntimeState();
  return completed;
}

/** Drop an active journal without declaring the turn successful. */
export function clearAgentJobJournal(): void {
  cancelScheduledFlush();
  removeDurableJournal();
  resetRuntimeState();
}

function scheduleFlush(delayMs: number) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (currentJournal) persistCurrentJournal();
  }, Math.max(0, delayMs));
}

function cancelScheduledFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

function persistCurrentJournal() {
  if (!currentJournal) return;
  cancelScheduledFlush();
  const serialized = JSON.stringify(currentJournal);
  try {
    journalStorage().setItem(AGENT_JOB_JOURNAL_KEY, serialized);
  } catch (error) {
    throw new Error(`Unable to persist Agent turn journal: ${String(error)}`);
  }
  lastPersistedAt = Date.now();
  pendingGrowthBytes = 0;
}

function removeDurableJournal() {
  try {
    journalStorage().removeItem(AGENT_JOB_JOURNAL_KEY);
  } catch (error) {
    throw new Error(`Unable to clear Agent turn journal: ${String(error)}`);
  }
}

function resetRuntimeState() {
  currentJournal = null;
  lastPersistedAt = 0;
  pendingGrowthBytes = 0;
}

function journalStorage(): Storage {
  if (typeof localStorage === "undefined") throw new Error("localStorage is unavailable");
  return localStorage;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function estimateStringGrowth(previous: string, next: string) {
  if (next === previous) return 0;
  if (next.startsWith(previous)) return byteLength(next.slice(previous.length));
  return Math.max(64, Math.abs(next.length - previous.length) * 3);
}

function truncateJournalText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const marker = "\n\n[…中间内容因恢复日志容量限制已省略…]\n\n";
  const head = Math.floor((limit - marker.length) * 0.75);
  const tail = limit - marker.length - head;
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function normalizeActivities(activities: AgentToolActivity[]): AgentToolActivity[] {
  return cloneActivities(activities.slice(-MAX_JOURNAL_ACTIVITIES).map((activity) => ({
    ...activity,
    output: activity.output === undefined
      ? undefined
      : truncateJournalText(activity.output, MAX_ACTIVITY_OUTPUT_CHARS),
  })));
}

function cloneActivities(activities: AgentToolActivity[]): AgentToolActivity[] {
  return activities.map((activity) => ({
    ...activity,
    input: cloneJsonRecord(activity.input),
  }));
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function cloneJournal(journal: AgentJobJournal): AgentJobJournal {
  return { ...journal, activities: cloneActivities(journal.activities) };
}

function validJournal(value: unknown): value is AgentJobJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Partial<AgentJobJournal>;
  return journal.schemaVersion === AGENT_JOB_JOURNAL_SCHEMA_VERSION
    && typeof journal.sessionId === "string"
    && Boolean(journal.sessionId)
    && typeof journal.turnId === "string"
    && Boolean(journal.turnId)
    && typeof journal.prompt === "string"
    && Boolean(journal.prompt.trim())
    && typeof journal.phase === "string"
    && AGENT_JOB_PHASES.has(journal.phase as AgentJobPhase)
    && typeof journal.draft === "string"
    && typeof journal.reasoning === "string"
    && Array.isArray(journal.activities)
    && journal.activities.every(validActivity)
    && typeof journal.provider === "string"
    && typeof journal.model === "string"
    && typeof journal.updatedAt === "number"
    && Number.isFinite(journal.updatedAt)
    && Number.isInteger(journal.seq)
    && (journal.seq ?? 0) >= 1;
}

function validActivity(value: unknown): value is AgentToolActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Partial<AgentToolActivity>;
  return typeof activity.id === "string"
    && typeof activity.name === "string"
    && Boolean(activity.input && typeof activity.input === "object" && !Array.isArray(activity.input))
    && (activity.status === "running" || activity.status === "done" || activity.status === "error")
    && (activity.output === undefined || typeof activity.output === "string");
}
