import type { BotActivityEvent, BotApproval } from "~/api/types";

/* ═══════════════════════════════════════════════════════════════
   The live feed's model: raw bot events → one card per run.

   A run's state is worked out from its latest event (Linear's rule), so
   it can't drift: an answered question or a finished run clears itself.
   "Waiting for you" comes only from a pending approval for that very run,
   never from wording, so nothing is flagged that isn't actually waiting.
   A run with no ending event whose bot is no longer running (the runtime
   restarted mid-run) is shown as ended, not "working" forever.
   ═══════════════════════════════════════════════════════════════ */

export type RunState = "queued" | "working" | "waiting" | "done" | "failed" | "stopped" | "paused" | "ended";

export interface LiveStep {
  label: string;
  status: "running" | "done" | "error" | "note";
  detail?: string;
  at: number;
}

export interface LiveRun {
  jobId: string;
  botId: string;
  botName: string;
  trigger?: string;
  prompt?: string;
  fromBot?: string;
  startedAt: number;
  updatedAt: number;
  steps: LiveStep[];
  /** Steps the model took (its step counter). */
  stepCount: number;
  /** The reply as it is being written (a rolling tail). */
  text?: string;
  reasoning?: string;
  state: RunState;
  /** How it ended, in the runtime's words ("completed", "failed: …"). */
  endLabel?: string;
}

/** Steps that only count ("step 4 · 12.3k tok in") rather than say something. */
const COUNTER = /^step \d+/;

function endState(e: BotActivityEvent): RunState {
  const l = e.label.toLowerCase();
  if (l.startsWith("paused")) return "paused";
  if (l.startsWith("stopped") || l === "halted") return "stopped";
  if (e.status === "error" || l.startsWith("failed")) return "failed";
  return "done";
}

/**
 * Runs from events (oldest first in, oldest first out). `running` is the set
 * of bots the runtime says are running now; `approvals` the questions
 * waiting. Deliveries outside a run join the bot's latest run.
 */
export function runsFrom(events: BotActivityEvent[], opts: { running?: Set<string>; approvals?: BotApproval[]; now?: number } = {}): LiveRun[] {
  const now = opts.now ?? Date.now();
  const runs = new Map<string, LiveRun>();
  const latestOf = new Map<string, LiveRun>();
  for (const e of events) {
    const at = e.at ?? now;
    let run = e.jobId ? runs.get(e.jobId) : latestOf.get(e.botId);
    if (!run) {
      if (!e.jobId && e.kind !== "tool") continue;
      run = {
        jobId: e.jobId || `loose-${e.botId}-${at}`, botId: e.botId, botName: e.botName ?? e.botId,
        startedAt: at, updatedAt: at, steps: [], stepCount: 0, state: e.kind === "queued" ? "queued" : "working",
      };
      runs.set(run.jobId, run);
    }
    if (e.jobId) latestOf.set(e.botId, run);
    run.updatedAt = Math.max(run.updatedAt, at);
    if (e.botName) run.botName = e.botName;
    switch (e.kind) {
      case "queued":
        run.prompt ??= e.prompt;
        run.trigger ??= e.trigger;
        break;
      case "turn-start":
        run.prompt = e.prompt ?? run.prompt ?? e.label;
        run.trigger = e.trigger ?? run.trigger;
        run.fromBot = e.fromBot ?? run.fromBot;
        run.state = "working";
        break;
      case "tool": {
        const status = e.status === "error" ? "error" : e.status === "running" ? "running" : "done";
        const open = [...run.steps].reverse().find((s) => s.label === e.label && s.status === "running");
        if (open && status !== "running") { open.status = status; open.detail = e.detail; open.at = at; }
        else run.steps.push({ label: e.label, status, ...(e.detail ? { detail: e.detail } : {}), at });
        if (run.state === "queued") run.state = "working";
        break;
      }
      case "step":
        if (COUNTER.test(e.label)) run.stepCount = Math.max(run.stepCount, e.stepIndex ?? 0);
        else if (run.steps[run.steps.length - 1]?.label !== e.label) run.steps.push({ label: e.label, status: "note", at });
        if (run.state === "queued") run.state = "working";
        break;
      case "thinking":
        if (e.textTail) run.text = e.textTail;
        if (e.reasoningTail) run.reasoning = e.reasoningTail;
        break;
      case "turn-end":
        run.state = endState(e);
        run.endLabel = e.label;
        // Nothing still "running" in a finished run.
        for (const s of run.steps) if (s.status === "running") s.status = run.state === "done" ? "done" : "error";
        break;
    }
  }
  const waiting = new Set((opts.approvals ?? []).map((a) => a.runId));
  for (const r of runs.values()) {
    if (waiting.has(r.jobId) && (r.state === "working" || r.state === "queued")) r.state = "waiting";
    // No ending event, and the bot isn't running any more: it ended without telling us (a restart).
    if (r.state === "working" && opts.running && !opts.running.has(r.botId) && now - r.updatedAt > 60_000) r.state = "ended";
  }
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued", working: "Working", waiting: "Waiting for you", done: "Done", failed: "Failed", stopped: "Stopped", paused: "Paused", ended: "Ended",
};

/** Who started a run, in words. */
export function startedBy(r: LiveRun, nameOf: (id: string) => string | undefined): string {
  if (r.trigger === "api" || r.trigger === "web" || r.trigger === "chat") return "You";
  if (r.trigger === "telegram") return "You · Telegram";
  if (r.trigger === "cloud") return "You · Cloud";
  if (r.trigger === "cron") return "Schedule";
  if (r.trigger === "mailbox") return r.fromBot ? `From ${nameOf(r.fromBot) ?? r.fromBot}` : "From the fleet";
  return r.trigger ? r.trigger[0].toUpperCase() + r.trigger.slice(1) : "Run";
}
