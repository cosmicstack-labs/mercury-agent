import { AlertTriangle, Brain, Check, ChevronRight, CircleAlert, CornerDownRight, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ThoughtStep, ThoughtTrace, TraceItem } from "~/api/types";
import type { AgentState } from "~/app/store";
import { formatDuration, runningStep } from "~/app/trace";
import { Markdown } from "~/components/Markdown";
import { StreamCaret } from "~/components/indicators/Thinking";
import { Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { MediaSkeleton } from "~/components/MediaSkeleton";

/* ═══════════════════════════════════════════════════════════════
   A turn as it happened, top to bottom: thinking, the tools it ran, the
   answer, notes — newest at the bottom, where the reader already is.
   Live, the open thinking block streams and the running tool ticks; a
   status line under it all always says what is happening and for how
   long, so a quiet model reads as waiting, never as a frozen screen.
   ═══════════════════════════════════════════════════════════════ */

/** The current time, re-rendered every `ms` while `active`. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return active ? now : Date.now();
}

type Block =
  | { kind: "reasoning"; item: Extract<TraceItem, { kind: "reasoning" }>; index: number }
  | { kind: "steps"; steps: ThoughtStep[]; index: number }
  | { kind: "text"; text: string; index: number }
  | { kind: "note"; text: string; index: number };

/** Items → blocks: consecutive tool calls form one group. Older traces (no items): thinking, then steps. */
export function blocksOf(trace: ThoughtTrace): Block[] {
  const items: TraceItem[] = trace.items ?? [
    ...(trace.reasoning.trim() ? [{ kind: "reasoning" as const, text: trace.reasoning, startedAt: trace.startedAt, endedAt: trace.endedAt ?? trace.startedAt }] : []),
    ...trace.steps.map((s, i) => ({ kind: "step" as const, key: s.key ?? `legacy-${i}` })),
  ];
  const byKey = new Map(trace.steps.map((s, i) => [s.key ?? `legacy-${i}`, s]));
  const blocks: Block[] = [];
  items.forEach((item, index) => {
    if (item.kind === "step") {
      const step = byKey.get(item.key);
      if (!step) return;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "steps") last.steps.push(step);
      else blocks.push({ kind: "steps", steps: [step], index });
    } else if (item.kind === "reasoning") {
      if (item.text.trim()) blocks.push({ kind: "reasoning", item, index });
    } else if (item.kind === "text") {
      if (item.text) blocks.push({ kind: "text", text: item.text, index });
    } else {
      blocks.push({ kind: "note", text: item.text, index });
    }
  });
  return blocks;
}

/** `expanded`: a finished turn opened on purpose — its thinking shows open too. */
export function TraceTimeline({ trace, live = false, expanded = false, now }: { trace: ThoughtTrace; live?: boolean; expanded?: boolean; now: number }) {
  const blocks = blocksOf(trace);
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((b, i) => {
        const last = live && i === blocks.length - 1;
        switch (b.kind) {
          case "reasoning":
            return <ReasoningBlock key={`r${b.index}`} text={b.item.text} startedAt={b.item.startedAt} endedAt={b.item.endedAt} active={last && !b.item.endedAt} expanded={expanded} now={now} />;
          case "steps":
            return <StepGroup key={`s${b.index}`} steps={b.steps} live={live} now={now} />;
          case "text":
            return (
              <div key={`t${b.index}`} className="min-w-0">
                <Markdown text={b.text} streaming={last} />
                {last && <StreamCaret />}
              </div>
            );
          case "note":
            return (
              <p key={`n${b.index}`} className="flex items-start gap-2 text-[13px] text-ink3">
                <CornerDownRight size={13} className="mt-[3px] shrink-0 text-ink4" aria-hidden="true" />
                <span className="min-w-0">{b.text.replace(/^[^\p{L}\p{N}*_`]+/u, "")}</span>
              </p>
            );
        }
      })}
    </div>
  );
}

/** One thinking block: open while it streams, folded to "Thought for 8s" once the model moves on. */
function ReasoningBlock({ text, startedAt, endedAt, active, expanded, now }: { text: string; startedAt: number; endedAt?: number; active: boolean; expanded: boolean; now: number }) {
  // Your click wins; otherwise open while it streams (and in an opened finished turn).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (active || expanded);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [text, active]);
  const took = formatDuration(Math.max(0, (endedAt ?? now) - startedAt));
  return (
    <div className="min-w-0">
      <button onClick={() => setUserOpen(!open)} className="group/r flex items-center gap-2 rounded-md py-0.5 text-sm text-ink3 hover:text-ink" aria-expanded={open}>
        <Brain size={14} className={cx(active && "text-cyan")} aria-hidden="true" />
        <span className={cx(active && "shimmer-text")}>{active ? `Thinking · ${took}` : `Thought for ${took}`}</span>
        <ChevronRight size={14} className={cx("transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={box}
          className={cx(
            "ml-[7px] mt-1 whitespace-pre-wrap border-l border-line pl-4 text-[13.5px] leading-relaxed text-ink3",
            active ? "thought-stream max-h-[7.5em] overflow-hidden" : "max-h-[18em] overflow-y-auto",
          )}
          data-selectable
        >
          {text.trim()}
        </div>
      )}
    </div>
  );
}

const SHOW_STEPS = 4;

/** A run of tool calls. Long runs show the latest few; failures always show. */
function StepGroup({ steps, live, now }: { steps: ThoughtStep[]; live: boolean; now: number }) {
  const [all, setAll] = useState(false);
  const hidden = all ? [] : steps.slice(0, Math.max(0, steps.length - SHOW_STEPS)).filter((s) => s.status !== "error" && s.status !== "running");
  const hiddenKeys = new Set(hidden);
  const shown = steps.filter((s) => !hiddenKeys.has(s));
  // A picture or voice being made in this reply: its placeholder until the reply lands
  // (the finished file arrives with it). Videos and songs have their own (PendingMedia).
  const making = live ? steps.filter((s) => s.media && (s.media.kind === "image" || s.media.kind === "speech") && s.status !== "error" && s.status !== "stopped") : [];
  return (
    <>
    <ol className="flex flex-col gap-1">
      {hidden.length > 0 && (
        <li>
          <button onClick={() => setAll(true)} className="flex items-center gap-2 py-0.5 text-[13px] text-ink4 hover:text-ink2">
            <ChevronRight size={13} aria-hidden="true" />
            {hidden.length} earlier step{hidden.length === 1 ? "" : "s"}
          </button>
        </li>
      )}
      {shown.map((s) => <StepRow key={s.key ?? `${s.id}-${s.startedAt}`} step={s} live={live} now={now} />)}
    </ol>
    {making.map((s) => (
      <MediaSkeleton key={`m-${s.key ?? s.id}`} shape={s.media!} startedAt={s.startedAt} now={now} note={s.status === "done" ? "Almost there…" : undefined} className="mt-1" />
    ))}
    </>
  );
}

function StepRow({ step: s, live, now }: { step: ThoughtStep; live: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const running = s.status === "running";
  const ms = s.durationMs ?? (s.endedAt ? s.endedAt - s.startedAt : running && live ? now - s.startedAt : undefined);
  const title = s.title || s.label;
  const failed = s.status === "error";
  const detail = s.summary && !running ? s.summary : "";
  return (
    <li className="min-w-0">
      <button
        onClick={() => detail && setOpen((o) => !o)}
        className={cx("flex w-full min-w-0 items-start gap-2 rounded-md text-left text-[13px]", detail && "hover:text-ink")}
        aria-expanded={detail ? open : undefined}
      >
        <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
          {running ? <Spinner size={11} className="text-accent" />
            : s.status === "stopped" ? <Square size={10} className="fill-current text-ink4" aria-label="stopped" />
            : failed ? <CircleAlert size={13} className="text-red" aria-label="failed" />
            : <Check size={13} className="text-accent" strokeWidth={2.5} aria-label="done" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate", running ? "text-ink" : "text-ink2", !s.title && "font-mono")} title={s.label}>{title}</span>
          {s.status === "stopped" && <span className="mt-0.5 block text-xs text-ink4">Stopped before it finished</span>}
          {detail && (failed || open) && (
            <span className={cx("mt-0.5 block break-words text-xs", failed ? "text-red/90" : "text-ink4", !open && "line-clamp-2")}>{detail}</span>
          )}
        </span>
        {ms !== undefined && <span className={cx("shrink-0 pt-px font-mono text-2xs", running ? "text-ink3" : "text-ink4")}>{formatDuration(ms)}</span>}
      </button>
    </li>
  );
}

/** How long without a word from the runtime before the status line says so. */
const QUIET_MS = 20_000;
const LONG_QUIET_MS = 120_000;

/**
 * The line under a running turn: what is happening right now and how long
 * the turn has taken. The only progress line (the chat box has none).
 */
export function LiveStatus({ trace, agent, stopping, now }: { trace: ThoughtTrace; agent: AgentState; stopping: boolean; now: number }) {
  const items = trace.items ?? [];
  const last = items[items.length - 1];
  const quietFor = now - (trace.lastEventAt ?? trace.startedAt);
  // Always shown while the turn runs: the one place that says what is happening.
  const writing = last?.kind === "text" && quietFor < 2500 && !stopping;
  const step = runningStep(trace);
  const thinking = last?.kind === "reasoning" && !last.endedAt;
  const what = stopping ? "Stopping"
    : writing ? "Writing"
    : step ? (step.title || step.label)
    : thinking ? "Thinking"
    : trace.phase ? trace.phase
    : agent === "needs-you" ? "Waiting for you"
    : items.length === 0 ? "Starting"
    : agent === "streaming" ? "Writing"
    : "Working";
  const total = formatDuration(Math.max(0, now - trace.startedAt));
  const waitingOnModel = !step && !stopping && agent !== "needs-you" && quietFor >= QUIET_MS;
  return (
    <div className="flex flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[13px] text-ink3">
        <Spinner size={12} className={stopping ? "text-ink4" : "text-cyan"} />
        <span className="min-w-0 truncate shimmer-text">{what}…</span>
        <span className="shrink-0 font-mono text-2xs text-ink4">{total}</span>
      </div>
      {waitingOnModel && (
        <p className={cx("ml-5 flex items-start gap-1.5 text-xs", quietFor >= LONG_QUIET_MS ? "text-amber" : "text-ink4")}>
          {quietFor >= LONG_QUIET_MS && <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden="true" />}
          {quietFor >= LONG_QUIET_MS
            ? `No response from the model for ${formatDuration(quietFor)}. It may be overloaded — you can stop and try again.`
            : `Waiting for the model · ${formatDuration(quietFor)}`}
        </p>
      )}
    </div>
  );
}
