import { CheckCircle2, ChevronDown, ListChecks, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useConversation, type Surface } from "~/app/conversation";
import { cx } from "~/lib/cx";

/**
 * The plan Mercury is working through, pinned above the composer: done
 * steps ticked, the current one half-filled, the rest open circles, like
 * the terminal's checklist. Minimize it to one line (remembered per
 * conversation); when every step is done it folds away and can be closed.
 *
 * Chat only shows real multi-step plans (three or more steps); Code shows
 * any plan, since coding always works from one.
 */

type Step = { label: string; status: "pending" | "active" | "done" };

const MIN_STEPS: Record<Surface, number> = { chat: 3, code: 1 };

function readFlag(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeFlag(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* per-device nicety only */ }
}

export function shouldShowPlan(surface: Surface, steps: Step[] | undefined): boolean {
  return !!steps && steps.length >= MIN_STEPS[surface];
}

export function PlanCard({ surface }: { surface: Surface }) {
  const plan = useConversation((s) => s.plan);
  const threadId = useConversation((s) => s.activeId);
  const agent = useConversation((s) => s.agent);
  const busy = agent === "thinking" || agent === "working" || agent === "streaming";
  const minKey = `mercury.plan.min.${threadId ?? "new"}`;
  const closedKey = `mercury.plan.closed.${threadId ?? "new"}`;
  const [minimized, setMinimized] = useState(() => readFlag(minKey) === "1");
  const [closedAt, setClosedAt] = useState(() => Number(readFlag(closedKey) ?? 0));
  useEffect(() => { setMinimized(readFlag(minKey) === "1"); setClosedAt(Number(readFlag(closedKey) ?? 0)); }, [minKey, closedKey]);

  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  const complete = steps.length > 0 && done === steps.length;
  const active = steps.find((s) => s.status === "active") ?? (complete ? null : steps.find((s) => s.status === "pending") ?? null);

  // A finished plan folds to one line by itself once the work stops.
  useEffect(() => { if (complete && !busy) setMinimized(true); }, [complete, busy]);

  if (!plan || !shouldShowPlan(surface, steps)) return null;
  // Closed by you: stays closed until Mercury changes the plan.
  if (closedAt && closedAt >= plan.updatedAt) return null;

  const toggle = () => { const next = !minimized; setMinimized(next); writeFlag(minKey, next ? "1" : null); };
  const close = () => { setClosedAt(plan.updatedAt); writeFlag(closedKey, String(plan.updatedAt)); };
  const pct = Math.round((done / steps.length) * 100);

  return (
    <div className="shrink-0 px-8 pt-1">
      <div className="mx-auto w-full max-w-[780px]">
        <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]" aria-label="Plan">
          <div className="flex items-center gap-3 px-4 py-2.5">
            <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={!minimized}>
              {complete ? <CheckCircle2 size={16} className="shrink-0 text-accent" /> : <ListChecks size={16} className="shrink-0 text-ink3" />}
              <span className="shrink-0 text-sm font-medium text-ink">{complete ? "Plan complete" : "Plan"}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink3">{done} of {steps.length}</span>
              {minimized && active && <span className="min-w-0 truncate text-sm text-ink2">· {active.label}</span>}
              <span className="ml-auto hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-ink/[0.08] sm:block" aria-hidden="true">
                <span className={cx("block h-full rounded-full transition-[width] duration-500", complete ? "bg-accent" : "bg-ink/60")} style={{ width: `${pct}%` }} />
              </span>
              <ChevronDown size={15} className={cx("shrink-0 text-ink4 transition-transform", !minimized && "rotate-180")} />
            </button>
            {complete && !busy && (
              <button onClick={close} className="rounded-md p-1 text-ink4 hover:bg-ink/[0.06] hover:text-ink" aria-label="Close the plan"><X size={14} /></button>
            )}
          </div>
          {!minimized && (
            <ol className="flex max-h-56 flex-col gap-0.5 overflow-y-auto border-t border-line px-3 py-2">
              {steps.map((s, i) => (
                <li key={`${i}-${s.label}`} className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5">
                  <StepMark status={s.status} live={busy && s.status === "active"} />
                  <span className={cx("min-w-0 flex-1 text-sm leading-snug",
                    s.status === "done" && "text-ink3",
                    s.status === "active" && "font-medium text-ink",
                    s.status === "pending" && "text-ink2")}>{s.label}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

/** ✓ done · ◐ in progress · ○ not started. */
function StepMark({ status, live }: { status: Step["status"]; live: boolean }) {
  if (status === "done") return <CheckCircle2 size={16} className="mt-px shrink-0 text-accent" aria-label="Done" />;
  if (status === "active") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" className={cx("mt-px shrink-0 text-accent", live && "animate-pulse")} role="img" aria-label="In progress">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.75 A6.25 6.25 0 0 1 8 14.25 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="mt-px shrink-0 text-ink4" role="img" aria-label="Not started">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
