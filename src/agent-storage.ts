import type { AgentConversationMessage } from "./agent-runtime";

const SESSIONS_KEY = "leafmark.agent.sessions.v1";
const MEMORIES_KEY = "leafmark.agent.memories.v1";
const MAX_SESSIONS = 30;
const MAX_MEMORIES = 400;

export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentConversationMessage[];
  /** Number of visible/applied messages. Messages after the cursor form redo history. */
  cursor: number;
}

export interface AgentMemory {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
  accessCount: number;
}

export function newAgentSession(): AgentSession {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: "新会话", createdAt: now, updatedAt: now, messages: [], cursor: 0 };
}

export function loadAgentSessions(): AgentSession[] {
  const sessions = readJson<AgentSession[]>(SESSIONS_KEY, []);
  return Array.isArray(sessions) ? sessions.filter(validSession).map(normalizeSession).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS) : [];
}

export function saveAgentSession(session: AgentSession): AgentSession[] {
  const next = [normalizeSession(session), ...loadAgentSessions().filter((item) => item.id !== session.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
  writeJson(SESSIONS_KEY, next);
  return next;
}

export function removeAgentSession(id: string): AgentSession[] {
  const next = loadAgentSessions().filter((session) => session.id !== id);
  writeJson(SESSIONS_KEY, next);
  return next;
}

export function searchAgentSessions(query: string, limit = 8): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return loadAgentSessions().flatMap((session) => activeAgentMessages(session)
    .filter((message) => message.content.toLocaleLowerCase().includes(needle))
    .map((message) => `[${session.title}] ${message.role}: ${message.content.slice(0, 500)}`))
    .slice(0, limit);
}

export function activeAgentMessages(session: AgentSession): AgentConversationMessage[] {
  const cursor = Math.max(0, Math.min(session.messages.length, session.cursor));
  return session.messages.slice(0, cursor);
}

/** Move the conversation cursor only after the native file transaction succeeds. */
export function setAgentTurnApplied(sessionId: string, turnId: string, applied: boolean): AgentSession[] {
  const sessions = loadAgentSessions();
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const indexes = session.messages.flatMap((message, index) => message.turnId === turnId ? [index] : []);
    if (!indexes.length) return session;
    const cursor = applied
      ? Math.max(session.cursor, indexes[indexes.length - 1] + 1)
      : Math.min(session.cursor, indexes[0]);
    return { ...session, cursor };
  });
  writeJson(SESSIONS_KEY, next);
  return next;
}

/** Starting a new turn after undo creates a new branch, so stale redo messages
 * must not remain callable after the native VCS clears its redo ref. */
export function discardAgentRedoBranches(): AgentSession[] {
  const next = loadAgentSessions().map((session) => {
    const messages = activeAgentMessages(session);
    return messages.length === session.messages.length ? session : { ...session, messages, cursor: messages.length };
  });
  writeJson(SESSIONS_KEY, next);
  return next;
}

export function storeAgentMemory(content: string, tags: string[] = []): AgentMemory {
  const normalized = content.trim();
  if (!normalized) throw new Error("记忆内容不能为空");
  const memories = loadAgentMemories();
  const duplicate = memories.find((memory) => memory.content === normalized);
  if (duplicate) return duplicate;
  const memory: AgentMemory = {
    id: crypto.randomUUID(),
    content: normalized.slice(0, 4000),
    tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12),
    createdAt: Date.now(),
    accessCount: 0,
  };
  writeJson(MEMORIES_KEY, [memory, ...memories].slice(0, MAX_MEMORIES));
  return memory;
}

export function searchAgentMemories(query: string, limit = 6): AgentMemory[] {
  const memories = loadAgentMemories();
  if (!query.trim()) return memories.slice(0, limit);
  const queryVector = featureVector(query);
  const ranked = memories.map((memory) => ({
    memory,
    score: cosineSimilarity(queryVector, featureVector(`${memory.content} ${memory.tags.join(" ")}`)) + Math.min(memory.accessCount, 20) * 0.002,
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  if (ranked.length) {
    const used = new Set(ranked.map((item) => item.memory.id));
    writeJson(MEMORIES_KEY, memories.map((memory) => used.has(memory.id) ? { ...memory, accessCount: memory.accessCount + 1 } : memory));
  }
  return ranked.map((item) => item.memory);
}

export function loadAgentMemories(): AgentMemory[] {
  const memories = readJson<AgentMemory[]>(MEMORIES_KEY, []);
  return Array.isArray(memories) ? memories.filter(validMemory).slice(0, MAX_MEMORIES) : [];
}

export function removeAgentMemory(id: string) {
  const next = loadAgentMemories().filter((memory) => memory.id !== id);
  writeJson(MEMORIES_KEY, next);
  return next;
}

export function relevantMemoryPrompt(query: string) {
  const memories = searchAgentMemories(query, 5);
  if (!memories.length) return "";
  return `\n\n与当前请求相关的长期记忆：\n${memories.map((memory) => `- ${memory.content}`).join("\n")}`;
}

function featureVector(text: string): Float32Array {
  const vector = new Float32Array(256);
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, " ");
  const tokens = normalized.match(/[\p{Script=Han}]|[\p{L}\p{N}_-]+/gu) ?? [];
  for (const token of tokens) {
    const features = token.length > 3 ? [token, ...characterNgrams(token, 3)] : [token];
    for (const feature of features) vector[hashFeature(feature) % vector.length] += 1;
  }
  return vector;
}

function characterNgrams(value: string, width: number) {
  const chars = [...value];
  return chars.length <= width ? [value] : chars.slice(0, chars.length - width + 1).map((_, index) => chars.slice(index, index + width).join(""));
}

function hashFeature(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cosineSimilarity(left: Float32Array, right: Float32Array) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable in private previews */ }
}

function validSession(value: AgentSession) {
  return Boolean(value && typeof value.id === "string" && typeof value.title === "string" && Array.isArray(value.messages));
}

function normalizeSession(session: AgentSession): AgentSession {
  const cursor = Number.isInteger(session.cursor)
    ? Math.max(0, Math.min(session.messages.length, session.cursor))
    : session.messages.length;
  return { ...session, cursor };
}

function validMemory(value: AgentMemory) {
  return Boolean(value && typeof value.id === "string" && typeof value.content === "string" && Array.isArray(value.tags));
}
