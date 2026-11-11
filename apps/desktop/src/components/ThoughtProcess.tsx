import { Brain, ChevronRight, Square } from "lucide-react";
import { useState } from "react";
import type { ThoughtTrace } from "~/api/types";
import { formatDuration } from "~/app/trace";
import { TraceTimeline } from "~/components/TurnTimeline";
import { cx } from "~/lib/cx";

/** "Thought for 12s", "Worked for 1m 05s · 6 steps · 1 failed", "Stopped after 9s · 2 steps". */
export function traceSummary(trace: ThoughtTrace): string {
  const took = formatDuration(Math.max(0, (trace.endedAt ?? trace.startedAt) - trace.startedAt));
  const n = trace.steps.length;
  const failed = trace.steps.filter((s) => s.status === "error").length;
  const steps = n ? ` · ${n} step${n === 1 ? "" : "s"}` : "";
  if (trace.stopped) return `Stopped after ${took}${steps}`;
  return `${n ? "Worked" : "Thought"} for ${took}${steps}${failed ? ` · ${failed} failed` : ""}`;
}

/**
 * How a finished answer was reached, folded into one line above it; open
 * on click for the thinking and every step, in the order they happened.
 * (The running turn shows the same timeline open, in StreamingMessage.)
 */
export function ThoughtProcess({ trace }: { trace: ThoughtTrace }) {
  const [open, setOpen] = useState(false);
  if (!trace.reasoning.trim() && trace.steps.length === 0 && !(trace.items ?? []).some((i) => i.kind === "note")) return null;
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 text-sm text-ink3 hover:text-ink" aria-expanded={open}>
        {trace.stopped ? <Square size={11} className="fill-current" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
        <span>{traceSummary(trace)}</span>
        <ChevronRight size={14} className={cx("transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div className="ml-[7px] mt-1 border-l border-line pl-4">
          <TraceTimeline trace={trace} expanded now={trace.endedAt ?? Date.now()} />
        </div>
      )}
    </div>
  );
}
