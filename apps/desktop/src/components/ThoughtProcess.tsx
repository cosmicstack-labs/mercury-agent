import { Brain, Check, ChevronRight, CircleAlert, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ThoughtTrace } from "~/api/types";
import { Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

/**
 * How an answer was reached. Live: open, with the reasoning streaming in a
 * short scrolling window and each step appearing as it runs. Done: folded
 * into one line ("Thought for 12s · 4 steps") above the answer, open on click.
 */
export function ThoughtProcess({ trace, live = false, stopping = false }: { trace: ThoughtTrace; live?: boolean; stopping?: boolean }) {
  const [open, setOpen] = useState(live);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (live) setOpen(true); }, [live]);
  useEffect(() => {
    const el = box.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [trace.reasoning, live]);

  const seconds = Math.max(1, Math.round(((trace.endedAt ?? Date.now()) - trace.startedAt) / 1000));
  const running = trace.steps.find((s) => s.status === "running");
  const failed = trace.steps.filter((s) => s.status === "error").length;
  const steps = trace.steps.length ? ` · ${trace.steps.length} step${trace.steps.length === 1 ? "" : "s"}` : "";
  const summary = live
    ? stopping ? "Stopping" : running ? `Running ${running.tool}` : trace.reasoning ? "Thinking" : "Starting"
    : trace.stopped ? `Stopped after ${seconds}s${steps}` : `Thought for ${seconds}s${trace.steps.length ? ` · ${trace.steps.length} step${trace.steps.length === 1 ? "" : "s"}` : ""}${failed ? ` · ${failed} failed` : ""}`;

  if (!live && !trace.reasoning && trace.steps.length === 0) return null;

  return (
    <div className="mb-3">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 text-sm text-ink3 hover:text-ink" aria-expanded={open}>
        {live ? <Spinner size={13} className="text-cyan" /> : trace.stopped ? <Square size={11} className="fill-current" aria-hidden="true" /> : <Brain size={14} aria-hidden="true" />}
        <span className={cx(live && "text-cyan")}>{summary}{live && "…"}</span>
        <ChevronRight size={14} className={cx("transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div className="ml-[7px] mt-1 border-l border-line pl-4">
          {trace.reasoning && (
            <div ref={box} className={cx("whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink3", live ? "thought-stream max-h-[7.5em] overflow-hidden" : "max-h-[18em] overflow-y-auto")} data-selectable>
              {trace.reasoning.trim()}
            </div>
          )}
          {trace.steps.length > 0 && (
            <ol className={cx("flex flex-col gap-1.5", trace.reasoning && "mt-3")}>
              {trace.steps.map((s) => (
                <li key={`${s.id}-${s.startedAt}`} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
                    {s.status === "running" ? <Spinner size={11} className="text-accent" /> : s.status === "stopped" ? <Square size={10} className="fill-current text-ink4" aria-label="stopped" /> : s.status === "error" ? <CircleAlert size={13} className="text-red" /> : <Check size={13} className="text-accent" strokeWidth={2.5} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="break-all font-mono text-ink2">{s.label}</span>
                    {s.status === "stopped" && <span className="mt-0.5 block text-xs text-ink4">Stopped before it finished</span>}
                    {s.summary && s.status !== "running" && <span className="mt-0.5 line-clamp-2 block text-xs text-ink4">{s.summary}</span>}
                  </span>
                  {s.endedAt && <span className="shrink-0 font-mono text-2xs text-ink4">{((s.endedAt - s.startedAt) / 1000).toFixed(1)}s</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
