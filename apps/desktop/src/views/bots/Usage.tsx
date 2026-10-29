import { useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { BotRunRecord, CostReport, UsageBucket } from "~/api/types";
import { Segmented, Spinner } from "~/components/ui/bits";
import { BotAvatar } from "~/components/BotAvatar";
import { cx } from "~/lib/cx";

/**
 * Token usage, in depth:
 *  - totals for the period (in, out, runs, success, deliverables, tokens per
 *    run and per deliverable) and today against the daily cap;
 *  - a bar per run (input and output stacked, failed runs marked), hover
 *    for numbers;
 *  - for a fleet, each member's share.
 */
export function Usage({ bots }: { bots: Array<{ id: string; name: string; hasAvatar?: boolean }> }) {
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [report, setReport] = useState<CostReport | null>(null);
  const [runs, setRuns] = useState<BotRunRecord[]>([]);
  const ids = bots.map((b) => b.id);
  const key = ids.join(",");

  useEffect(() => {
    let live = true;
    setReport(null);
    void api.bots.cost(Number(days)).then((r) => { if (live) setReport(r); }).catch(() => {});
    void Promise.all(ids.map((id) => api.bots.journal(id, 100).then((r) => r.journal).catch(() => [] as BotRunRecord[])))
      .then((all) => { if (live) setRuns(all.flat()); });
    return () => { live = false; };
  }, [key, days]);

  const rows = useMemo(() => (report?.bots ?? []).filter((b) => ids.includes(b.id)), [report, key]);
  const total = useMemo(() => sum(rows.map((r) => r.window)), [rows]);
  const today = useMemo(() => sum(rows.map((r) => r.today)), [rows]);
  const cap = rows.reduce((n, r) => n + (r.cap || 0), 0);
  const since = Date.now() - Number(days) * 86_400_000;
  const periodRuns = runs.filter((r) => r.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt).slice(-80);

  if (!report) return <div className="flex h-40 items-center justify-center text-ink3"><Spinner size={18} /></div>;

  const tokens = total.tokensIn + total.tokensOut;
  const success = total.runs ? Math.round((total.completed / total.runs) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink3">{bots.length > 1 ? `${bots.length} bots in this fleet` : "This bot"}</span>
        <Segmented size="md" value={days} onChange={setDays} options={[{ value: "1", label: "24 h" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Tile label="Tokens" value={compact(tokens)} sub={`${compact(total.tokensIn)} in · ${compact(total.tokensOut)} out`} />
        <Tile label="Runs" value={String(total.runs)} sub={`${success}% completed · ${total.failed} failed`} tone={total.runs && success < 50 ? "warn" : undefined} />
        <Tile label="Per run" value={total.runs ? compact(Math.round(tokens / total.runs)) : "—"} sub="tokens on average" />
        <Tile label="Deliverables" value={String(total.deliverables)} sub={total.deliverables ? `${compact(Math.round(tokens / total.deliverables))} tokens each` : "none in this period"} />
      </div>

      {cap > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-ink">Today against the daily cap</span>
            <span className="font-mono text-xs text-ink3">{compact(today.tokensIn + today.tokensOut)} / {compact(cap)}</span>
          </div>
          <Meter ratio={(today.tokensIn + today.tokensOut) / cap} />
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-ink">Tokens per run</span>
          <span className="flex items-center gap-3 text-xs text-ink3">
            <Legend className="bg-accent" label="input" /><Legend className="bg-cyan" label="output" /><Legend className="bg-red" label="failed run" />
          </span>
        </div>
        <RunBars runs={periodRuns} names={new Map(bots.map((b) => [b.id, b.name]))} />
      </div>

      {bots.length > 1 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 text-sm text-ink">Share of the fleet</div>
          <div className="flex flex-col gap-2.5">
            {[...rows].sort((a, b) => (b.window.tokensIn + b.window.tokensOut) - (a.window.tokensIn + a.window.tokensOut)).map((r) => {
              const t = r.window.tokensIn + r.window.tokensOut;
              const bot = bots.find((b) => b.id === r.id);
              return (
                <div key={r.id} className="grid grid-cols-[200px_1fr_120px] items-center gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2"><BotAvatar id={r.id} name={r.name} hasAvatar={bot?.hasAvatar} size={20} /><span className="truncate text-ink">{bot?.name ?? r.name}</span></span>
                  <span className="h-2 overflow-hidden rounded-full bg-ink/[0.08]"><span className="block h-full rounded-full bg-accent" style={{ width: `${tokens ? (t / tokens) * 100 : 0}%` }} /></span>
                  <span className="text-right font-mono text-xs text-ink3">{compact(t)} · {r.window.runs} runs</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function RunBars({ runs, names }: { runs: BotRunRecord[]; names: Map<string, string> }) {
  const [hover, setHover] = useState<BotRunRecord | null>(null);
  if (runs.length === 0) return <p className="text-sm text-ink4">No runs in this period.</p>;
  const max = Math.max(...runs.map((r) => r.tokensIn + r.tokensOut), 1);
  return (
    <div>
      <div className="flex h-36 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {runs.map((r) => {
          const total = r.tokensIn + r.tokensOut;
          const h = Math.max(2, (total / max) * 100);
          const outShare = total ? r.tokensOut / total : 0;
          return (
            <div key={`${r.botId}/${r.runId}`} onMouseEnter={() => setHover(r)} className="relative flex min-w-[4px] flex-1 flex-col justify-end" style={{ height: "100%" }}>
              <div className={cx("flex w-full flex-col overflow-hidden rounded-t-[3px]", hover === r && "opacity-80")} style={{ height: `${h}%` }}>
                <div className={r.state === "failed" ? "bg-red" : "bg-cyan"} style={{ height: `${Math.max(outShare * 100, 4)}%` }} />
                <div className={cx("flex-1", r.state === "failed" ? "bg-red/60" : "bg-accent")} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 h-5 text-xs text-ink3">
        {hover
          ? `${names.get(hover.botId) ?? hover.botId} · ${new Date(hover.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${hover.tokensIn.toLocaleString()} in · ${hover.tokensOut.toLocaleString()} out · ${hover.state}`
          : `${runs.length} runs · hover a bar for details`}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "warn" }) {
  return (
    <div className={cx("rounded-xl border bg-surface p-4", tone === "warn" ? "border-amber/40" : "border-line")}>
      <div className="text-xs text-ink4">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-ink3">{sub}</div>
    </div>
  );
}

function Meter({ ratio }: { ratio: number }) {
  const r = Math.min(1, Math.max(0, ratio));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-ink/[0.08]">
      <div className={cx("h-full rounded-full", r > 0.9 ? "bg-red" : r > 0.7 ? "bg-amber" : "bg-accent")} style={{ width: `${r * 100}%` }} />
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cx("block h-2 w-2 rounded-sm", className)} />{label}</span>;
}

function sum(list: UsageBucket[]): UsageBucket {
  return list.reduce((a, b) => ({
    runs: a.runs + b.runs, completed: a.completed + b.completed, failed: a.failed + b.failed, noOutcome: a.noOutcome + b.noOutcome,
    deliverables: a.deliverables + b.deliverables, tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut,
  }), { runs: 0, completed: 0, failed: 0, noOutcome: 0, deliverables: 0, tokensIn: 0, tokensOut: 0 });
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
