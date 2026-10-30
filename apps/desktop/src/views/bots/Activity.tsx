import { Check, ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { BotRunRecord, RunTranscript } from "~/api/types";
import { Badge, Empty, Mono, Spinner } from "~/components/ui/bits";
import { BotAvatar } from "~/components/BotAvatar";
import { Markdown } from "~/components/Markdown";
import { cx } from "~/lib/cx";
import { compact } from "./Usage";

/**
 * Activity: every run, newest first, across the fleet for a lead. Open a
 * run to see its thought process: what it was asked, each step it took
 * (tool, argument, worked or not) as a timeline, and what it concluded.
 */
export function Activity({ bots }: { bots: Array<{ id: string; name: string; hasAvatar?: boolean }> }) {
  const [runs, setRuns] = useState<BotRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "completed" | "failed">("all");
  const ids = bots.map((b) => b.id).join(",");
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [ids]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all(bots.map((b) => api.bots.journal(b.id, 60).then((r) => r.journal).catch(() => [] as BotRunRecord[])))
      .then((all) => { if (live) { setRuns(all.flat().sort((a, b) => b.startedAt - a.startedAt)); setLoading(false); } });
    return () => { live = false; };
  }, [ids]);

  const shown = runs.filter((r) => filter === "all" || (filter === "failed" ? r.state === "failed" : r.state === "completed"));
  if (loading) return <div className="flex h-40 items-center justify-center text-ink3"><Spinner size={18} /></div>;
  if (runs.length === 0) return <Empty title="No runs yet" />;

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex items-center gap-2 text-sm">
        {(["all", "completed", "failed"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cx("rounded-full px-3 py-1 capitalize", filter === f ? "bg-ink/[0.08] text-ink" : "text-ink3 hover:text-ink")}>
            {f} {f === "all" ? runs.length : runs.filter((r) => r.state === f).length}
          </button>
        ))}
      </div>
      {shown.map((r) => {
        const bot = byId.get(r.botId);
        const isOpen = open === `${r.botId}/${r.runId}`;
        return (
          <div key={`${r.botId}/${r.runId}`} className={cx("rounded-xl border bg-surface", r.state === "failed" ? "border-red/25" : "border-line")}>
            <button onClick={() => setOpen(isOpen ? null : `${r.botId}/${r.runId}`)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={isOpen}>
              <ChevronRight size={15} className={cx("shrink-0 text-ink4 transition-transform", isOpen && "rotate-90")} aria-hidden="true" />
              {bots.length > 1 && bot && <BotAvatar id={bot.id} name={bot.name} hasAvatar={bot.hasAvatar} size={22} />}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 text-sm text-ink">{r.summary || r.error || r.reasonCode || r.state}</span>
                <span className="text-xs text-ink4">{bots.length > 1 && bot ? `${bot.name} · ` : ""}{new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {r.trigger}</span>
              </span>
              <Badge tone={r.state === "completed" ? "accent" : r.state === "failed" ? "red" : "neutral"}>{r.state}</Badge>
              <Mono className="w-[150px] shrink-0 text-right">{Math.round(r.durationMs / 1000)}s · {compact(r.tokensIn + r.tokensOut)} tok</Mono>
            </button>
            {isOpen && <RunDetail botId={r.botId} runId={r.runId} />}
          </div>
        );
      })}
    </div>
  );
}

function RunDetail({ botId, runId }: { botId: string; runId: string }) {
  const [t, setT] = useState<RunTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.bots.run(botId, runId).then((x) => { if (live) setT(x); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [botId, runId]);

  if (error) return <p className="px-5 pb-4 text-sm text-ink3">No transcript for this run ({error}).</p>;
  if (!t) return <div className="px-5 pb-4 text-ink3"><Spinner size={14} /></div>;
  const rec = t.record;
  const failedSteps = t.trace.filter((s) => !s.ok).length;
  return (
    <div className="grid grid-cols-[1fr_220px] gap-6 border-t border-line px-5 py-4">
      <div className="flex min-w-0 flex-col gap-4">
        {t.prompt && (
          <section>
            <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink4">Asked</h4>
            <p className="whitespace-pre-wrap text-sm text-ink2" data-selectable>{t.prompt}</p>
          </section>
        )}
        <section>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink4">Thought process · {t.trace.length} step{t.trace.length === 1 ? "" : "s"}{failedSteps ? ` · ${failedSteps} failed` : ""}</h4>
          {t.trace.length === 0 && <p className="text-sm text-ink4">Answered without tools.</p>}
          <ol className="relative ml-2 border-l border-line">
            {t.trace.map((s, i) => (
              <li key={i} className="relative pb-3 pl-5 last:pb-0">
                <span className={cx("absolute -left-[9px] top-0.5 flex h-[17px] w-[17px] items-center justify-center rounded-full border bg-surface", s.ok ? "border-accent/50 text-accent" : "border-red/50 text-red")}>
                  {s.ok ? <Check size={11} strokeWidth={3} /> : <CircleAlert size={11} strokeWidth={2.5} />}
                </span>
                <span className="font-mono text-[13px] text-ink">{s.name}</span>
                {s.arg && <span className="ml-2 break-all font-mono text-xs text-ink3" data-selectable>{s.arg}</span>}
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink4">Concluded</h4>
          <Markdown text={t.output || rec.summary || "(no output)"} />
        </section>
      </div>
      <aside className="flex flex-col gap-3 text-sm">
        <Stat label="Outcome" value={rec.outcome ?? rec.state} />
        <Stat label="Duration" value={`${(rec.durationMs / 1000).toFixed(1)} s`} />
        <Stat label="Steps / tool calls" value={`${rec.steps ?? "—"} / ${rec.toolCalls ?? t.trace.length}`} />
        <Stat label="Tokens in" value={rec.tokensIn.toLocaleString()} />
        <Stat label="Tokens out" value={rec.tokensOut.toLocaleString()} />
        {rec.peakInputTokens !== undefined && <Stat label="Largest prompt" value={`${rec.peakInputTokens.toLocaleString()} tok`} />}
        <Stat label="Run" value={<Mono>{rec.runId}</Mono>} />
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink4">{label}</div>
      <div className="text-ink">{value}</div>
    </div>
  );
}
