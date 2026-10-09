/**
 * Context window v2 — what the model sees from the session.
 *
 * Replaces the "last ten text messages" window with one that is budgeted by
 * tokens and that includes the compact per-turn tool trace, so turn N+1
 * remembers which files turn N read and wrote instead of starting blind.
 * Retrieved memory and loop warnings are NOT turned into fake user/assistant
 * dialogue any more; callers put them in the volatile system block.
 */
import type { SessionMessage } from '../sessions/types.js';

/** Token budget for history in normal mode. Rough: 4 chars per token. */
export const HISTORY_TOKEN_BUDGET = 6000;
/** Token budget for history in Saver Mode. */
export const HISTORY_TOKEN_BUDGET_SAVER = 2400;
/** Hard cap on history entries regardless of budget. */
export const HISTORY_MAX_ENTRIES = 40;
/** Always keep at least this many entries so the model sees the last exchange. */
export const HISTORY_MIN_ENTRIES = 2;
/** Session message kind used for the per-turn tool trace entry. */
export const TOOL_TRACE_KIND = 'tool-call' as const;
/** Max lines kept in one turn's trace and max chars per line. */
export const TOOL_TRACE_MAX_LINES = 40;
export const TOOL_TRACE_LINE_CHARS = 160;

export const estimateTokens = (text: string): number => Math.ceil((text?.length ?? 0) / 4);

/** Entries the model may see: user/assistant text and our own tool traces. */
export function isHistoryEligible(entry: SessionMessage): boolean {
  if (entry.role !== 'user' && entry.role !== 'assistant') return false;
  if (entry.kind === 'message') return true;
  return entry.kind === TOOL_TRACE_KIND;
}

/**
 * Newest-first selection under a token budget, returned oldest-first.
 * The budget counts content only (reasoning is attached separately and only
 * for providers that want it).
 */
export function selectHistoryWindow(
  messages: readonly SessionMessage[],
  budgetTokens: number,
  maxEntries = HISTORY_MAX_ENTRIES,
): SessionMessage[] {
  const eligible = messages.filter(isHistoryEligible);
  const picked: SessionMessage[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const entry = eligible[i];
    const cost = estimateTokens(entry.content);
    const mustKeep = picked.length < HISTORY_MIN_ENTRIES;
    if (!mustKeep && (picked.length >= maxEntries || used + cost > budgetTokens)) break;
    picked.push(entry);
    used += cost;
  }
  return picked.reverse();
}

// Reasoning is kept beside the message object, never on it: the AI SDK
// validates message shapes and some providers reject unknown fields. Only
// DeepSeek thinking models want it back (issue #24).
const REASONING = new WeakMap<object, string>();

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function toModelMessage(entry: SessionMessage): ModelMessage {
  const message: ModelMessage = { role: entry.role as 'user' | 'assistant', content: entry.content };
  if (entry.role === 'assistant' && typeof entry.reasoning === 'string' && entry.reasoning.trim()) {
    REASONING.set(message, entry.reasoning);
  }
  return message;
}

/**
 * For providers that require prior reasoning to be passed back (DeepSeek
 * thinking mode), convert assistant messages that carry stored reasoning
 * into part arrays. Other messages are returned untouched.
 */
export function withReasoningParts(messages: readonly unknown[]): unknown[] {
  return messages.map((m) => {
    const reasoning = typeof m === 'object' && m ? REASONING.get(m) : undefined;
    if (!reasoning) return m;
    const msg = m as ModelMessage;
    return {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: reasoning },
        { type: 'text', text: msg.content },
      ],
    };
  });
}

/** Fields worth showing for a tool call, in priority order. */
const ARG_KEYS = ['path', 'file', 'command', 'query', 'url', 'pattern', 'name', 'skill', 'task', 'message'];

export function summarizeToolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return `${key}=${truncate(value.replace(/\s+/g, ' ').trim(), 80)}`;
  }
  const first = Object.entries(record).find(([, v]) => typeof v === 'string' && (v as string).trim());
  return first ? `${first[0]}=${truncate((first[1] as string).replace(/\s+/g, ' ').trim(), 80)}` : '';
}

export function summarizeToolResult(result: unknown, ok: boolean): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const head = text.replace(/\s+/g, ' ').trim();
  if (!ok) return `✗ ${truncate(head, 70)}`;
  const lines = typeof result === 'string' ? result.split('\n').length : 1;
  return lines > 3 ? `ok (${lines} lines)` : `ok ${truncate(head, 50)}`;
}

export interface ToolTraceStep {
  tool: string;
  args: string;
  outcome: string;
}

export function formatToolTraceLine(step: ToolTraceStep): string {
  return truncate(`- ${step.tool}${step.args ? ` ${step.args}` : ''} → ${step.outcome}`, TOOL_TRACE_LINE_CHARS);
}

/** The single session entry written at turn end summarising tool activity. */
export function formatToolTrace(lines: readonly string[]): string {
  const kept = lines.length > TOOL_TRACE_MAX_LINES
    ? [...lines.slice(0, TOOL_TRACE_MAX_LINES - 1), `- … ${lines.length - (TOOL_TRACE_MAX_LINES - 1)} more tool calls`]
    : [...lines];
  return `[Tool activity in my previous turn]\n${kept.join('\n')}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Warning injected when the last three assistant replies are near-identical. */
export const TEXT_REPETITION_WARNING =
  '[SYSTEM WARNING] Your last 3 responses are nearly identical. You are stuck in a text repetition loop. Stop immediately and give a completely different response. If you cannot complete the task, tell the user clearly why.';

const normalizeText = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
const overlap = (a: string, b: string): number => {
  const wa = new Set(a.split(' '));
  const wb = new Set(b.split(' '));
  return [...wa].filter((w) => wb.has(w)).length / Math.max(wa.size, 1);
};

/**
 * Detect a reply-repetition loop in recent history: three consecutive
 * assistant replies whose word sets overlap by more than 75%. Returns the
 * warning text to put in the volatile context block, or null.
 * (An older check for repeated "[Using: tool]" markers was removed: those
 * markers were never written to history, so it could never fire.)
 */
export function detectRepetitionLoop(recent: readonly { role: string; content: string }[]): string | null {
  const replies = recent.slice(-6).filter((m) => m.role === 'assistant' && m.content.length > 20);
  if (replies.length < 3) return null;
  const [a, b, c] = replies.slice(-3).map((m) => normalizeText(m.content));
  if (!a || !b || !c) return null;
  return overlap(a, b) > 0.75 && overlap(b, c) > 0.75 ? TEXT_REPETITION_WARNING : null;
}
