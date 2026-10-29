import { Check, CircleAlert } from "lucide-react";
import { cx } from "~/lib/cx";
import { Spinner } from "~/components/ui/bits";

/** One tool call: running, done, or failed. Plain language first, the tool name second. */
export function ActionResult({ tool, status, detail }: { tool: string; status: "running" | "done" | "error"; detail?: string }) {
  return (
    <div className={cx("flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs", status === "error" && "border-red/30")}>
      {status === "running" && <Spinner size={12} className="text-accent" />}
      {status === "done" && <Check size={13} className="text-accent" aria-hidden="true" />}
      {status === "error" && <CircleAlert size={13} className="text-red" aria-hidden="true" />}
      <span className="font-mono text-ink">{tool}</span>
      {detail && <span className="truncate text-ink3">{detail}</span>}
    </div>
  );
}

/** A step in the agent's plan. */
export function PlanStep({ label, state }: { label: string; state: "todo" | "doing" | "done" | "blocked" }) {
  return (
    <div className={cx("flex items-center gap-2.5 text-sm", state === "todo" && "text-ink3", state === "doing" && "text-ink", state === "done" && "text-ink2", state === "blocked" && "text-amber")}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        {state === "todo" && <span className="block h-3.5 w-3.5 rounded-full border border-line-strong" />}
        {state === "doing" && <span className="block h-3.5 w-3.5 animate-ring-spin rounded-full border-[1.5px] border-cyan border-r-transparent" />}
        {state === "done" && <Check size={14} className="text-accent" />}
        {state === "blocked" && <span className="block h-2 w-2 rounded-full bg-amber" />}
      </span>
      <span className={cx("truncate", state === "done" && "line-through decoration-ink4")}>{label}</span>
    </div>
  );
}

/** Token budget for the day. */
export function BudgetMeter({ used, budget }: { used: number; budget: number }) {
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;
  return (
    <div className="flex items-center gap-2 font-mono text-2xs text-ink3" title={`${used.toLocaleString()} of ${budget.toLocaleString()} tokens today`}>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-ink/[0.1]" aria-hidden="true">
        <span className={cx("block h-full rounded-full", ratio > 0.9 ? "bg-red" : ratio > 0.7 ? "bg-amber" : "bg-accent")} style={{ width: `${ratio * 100}%` }} />
      </span>
      {Math.round(ratio * 100)}%
    </div>
  );
}

/** Inline "noted" chip: a thing the agent will remember or has recorded. */
export function Noted({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-2xs text-ink2"><Check size={11} className="text-accent" aria-hidden="true" />{children}</span>;
}
