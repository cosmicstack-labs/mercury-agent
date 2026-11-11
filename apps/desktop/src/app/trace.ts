/* ═══════════════════════════════════════════════════════════════
   A turn's thought process as a timeline, in the order it happened:
   thinking, tool calls, the answer as it streams, notes ("Checking my
   work…"). Pure functions over ThoughtTrace so the event handler, the
   stop button and the history loader all build the same shape.

   `items` is the order; `steps` holds each tool call's state (an item
   points at its step by key); `reasoning` is all the thinking joined, for
   older readers.
   ═══════════════════════════════════════════════════════════════ */

import type { ChatMessage, ThoughtStep, ThoughtTrace, TraceItem } from "~/api/types";

const MAX_REASONING = 24_000;
const MAX_ITEMS = 300;

export function newTrace(now = Date.now()): ThoughtTrace {
  return { reasoning: "", steps: [], items: [], startedAt: now, lastEventAt: now };
}

function itemsOf(t: ThoughtTrace): TraceItem[] {
  return t.items ?? [];
}

function cap(items: TraceItem[]): TraceItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** The tool step running right now (the latest one), if any. */
export function runningStep(t: ThoughtTrace): ThoughtStep | undefined {
  for (let i = t.steps.length - 1; i >= 0; i--) if (t.steps[i].status === "running") return t.steps[i];
  return undefined;
}

export function addReasoning(t: ThoughtTrace, text: string, now = Date.now()): ThoughtTrace {
  if (!text) return t;
  const items = [...itemsOf(t)];
  const last = items[items.length - 1];
  if (last?.kind === "reasoning" && !last.endedAt) items[items.length - 1] = { ...last, text: last.text + text };
  else items.push({ kind: "reasoning", text, startedAt: now });
  return { ...t, items: cap(items), reasoning: (t.reasoning + text).slice(-MAX_REASONING), lastEventAt: now, phase: undefined };
}

/** The current thinking block ended (the answer, a tool call or a new step began). */
export function endReasoning(t: ThoughtTrace, now = Date.now()): ThoughtTrace {
  const items = itemsOf(t);
  const last = items[items.length - 1];
  if (last?.kind !== "reasoning" || last.endedAt) return { ...t, lastEventAt: now };
  return { ...t, items: [...items.slice(0, -1), { ...last, endedAt: now }], reasoning: t.reasoning ? `${t.reasoning}\n\n` : t.reasoning, lastEventAt: now };
}

export function startTool(t: ThoughtTrace, ev: { key?: string; tool: string; title?: string; label?: string; step?: number }, now = Date.now()): ThoughtTrace {
  const closed = endReasoning(t, now);
  const key = ev.key || `${ev.tool}:${now}:${closed.steps.length}`;
  if (closed.steps.some((s) => s.key === key)) return closed;
  const step: ThoughtStep = {
    id: ev.step ?? closed.steps.length + 1,
    key,
    tool: ev.tool,
    label: ev.label || ev.tool,
    ...(ev.title ? { title: ev.title } : {}),
    status: "running",
    startedAt: now,
  };
  return {
    ...closed,
    steps: [...closed.steps, step].slice(-MAX_ITEMS),
    items: cap([...itemsOf(closed), { kind: "step", key }]),
    lastEventAt: now,
    phase: undefined,
  };
}

export function finishTool(
  t: ThoughtTrace,
  ev: { key?: string; tool: string; failed: boolean; summary?: string; durationMs?: number },
  now = Date.now(),
): ThoughtTrace {
  const steps = [...t.steps];
  let i = -1;
  if (ev.key) i = steps.findIndex((s) => s.key === ev.key);
  // Older runtimes: no call id, match the latest running step of that tool.
  if (i < 0) for (let j = steps.length - 1; j >= 0; j--) if (steps[j].status === "running" && steps[j].tool === ev.tool) { i = j; break; }
  if (i < 0) return { ...t, lastEventAt: now };
  const s = steps[i];
  const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : now - s.startedAt;
  steps[i] = { ...s, status: ev.failed ? "error" : "done", summary: ev.summary, endedAt: s.startedAt + durationMs, durationMs };
  return { ...t, steps, lastEventAt: now };
}

/** Answer text as it streams, in order with the tools around it. */
export function addText(t: ThoughtTrace, text: string, now = Date.now()): ThoughtTrace {
  if (!text) return t;
  const closed = endReasoning(t, now);
  const items = [...itemsOf(closed)];
  const last = items[items.length - 1];
  if (last?.kind === "text") items[items.length - 1] = { ...last, text: last.text + text };
  else items.push({ kind: "text", text });
  return { ...closed, items: cap(items), lastEventAt: now, phase: undefined };
}

export function addNote(t: ThoughtTrace, text: string, now = Date.now()): ThoughtTrace {
  if (!text.trim()) return t;
  const closed = endReasoning(t, now);
  return { ...closed, items: cap([...itemsOf(closed), { kind: "note", text, at: now }]), lastEventAt: now };
}

export function setPhase(t: ThoughtTrace, phase: string, now = Date.now()): ThoughtTrace {
  return { ...t, phase, lastEventAt: now };
}

/** Any event from the runtime: the turn is alive. */
export function touch(t: ThoughtTrace, now = Date.now()): ThoughtTrace {
  return { ...t, lastEventAt: now };
}

/** Did the turn think or run anything worth keeping above the answer? */
export function hasProcess(t: ThoughtTrace | null | undefined): t is ThoughtTrace {
  return !!t && (!!t.reasoning.trim() || t.steps.length > 0 || itemsOf(t).some((i) => i.kind === "note"));
}

/**
 * The trace kept on the finished reply: no streamed text (the reply has
 * it), every step ended. `stopped`: running steps were cut off.
 */
export function finishTrace(t: ThoughtTrace, opts: { stopped?: boolean } = {}, now = Date.now()): ThoughtTrace {
  const closed = endReasoning(t, now);
  return {
    reasoning: closed.reasoning.trim(),
    startedAt: closed.startedAt,
    endedAt: now,
    ...(opts.stopped ? { stopped: true } : {}),
    items: itemsOf(closed).filter((i) => i.kind !== "text"),
    steps: closed.steps.map((s) => (s.status === "running"
      ? { ...s, status: opts.stopped ? ("stopped" as const) : ("done" as const), endedAt: now, durationMs: now - s.startedAt }
      : s)),
  };
}

/** Stop pressed: what was running shows as stopped straight away. */
export function markStopped(t: ThoughtTrace, now = Date.now()): ThoughtTrace {
  return { ...t, steps: t.steps.map((s) => (s.status === "running" ? { ...s, status: "stopped" as const, endedAt: now, durationMs: now - s.startedAt } : s)) };
}

/* ── history ── */

interface StoredItem {
  kind?: unknown; text?: unknown; startedAt?: unknown; endedAt?: unknown;
  id?: unknown; title?: unknown; status?: unknown; durationMs?: unknown; summary?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A reply's trace as the runtime keeps it ({startedAt, endedAt, items}) →
 * the screen's shape. A trace already in that shape passes through.
 */
export function fromStored(raw: unknown): ThoughtTrace | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { startedAt?: unknown; endedAt?: unknown; items?: unknown; reasoning?: unknown; steps?: unknown };
  if (typeof r.reasoning === "string" && Array.isArray(r.steps)) return raw as ThoughtTrace;
  if (!Array.isArray(r.items)) return undefined;
  const startedAt = num(r.startedAt) ?? Date.now();
  const trace: ThoughtTrace = { reasoning: "", steps: [], items: [], startedAt, endedAt: num(r.endedAt) ?? startedAt };
  const parts: string[] = [];
  for (const it of r.items as StoredItem[]) {
    if (it?.kind === "reasoning" && typeof it.text === "string" && it.text.trim()) {
      trace.items!.push({ kind: "reasoning", text: it.text, startedAt: num(it.startedAt) ?? startedAt, endedAt: num(it.endedAt) ?? startedAt });
      parts.push(it.text.trim());
    } else if (it?.kind === "tool" && typeof it.id === "string") {
      const title = typeof it.title === "string" ? it.title : "";
      const at = num(it.startedAt) ?? startedAt;
      const durationMs = num(it.durationMs);
      trace.steps.push({
        id: trace.steps.length + 1,
        key: it.id,
        tool: title.split(" ")[0] || "tool",
        label: title,
        title,
        status: it.status === "error" ? "error" : "done",
        startedAt: at,
        ...(durationMs !== undefined ? { durationMs, endedAt: at + durationMs } : {}),
        ...(typeof it.summary === "string" ? { summary: it.summary } : {}),
      });
      trace.items!.push({ kind: "step", key: it.id });
    }
  }
  trace.reasoning = parts.join("\n\n");
  return trace.items!.length ? trace : undefined;
}

/**
 * Messages from the runtime → the screen: stored traces normalised, and the
 * separate "used N tools" entry dropped where the reply carries the same
 * calls in its own trace.
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !(m as { trace?: unknown }).trace) { out.push(m); continue; }
    const trace = fromStored((m as { trace?: unknown }).trace);
    const msg: ChatMessage = { ...m };
    if (trace) msg.trace = trace;
    else delete msg.trace;
    if (trace?.steps.length) {
      const prev = out[out.length - 1];
      if (prev && (prev.kind === "tool-call" || prev.role === "tool")) out.pop();
    }
    out.push(msg);
  }
  return out;
}

/** "0.4s", "12s", "1m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
