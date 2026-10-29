import { useEffect, useMemo, useState } from "react";
import { http } from "~/api/client";
import { Spinner } from "~/components/ui/bits";
import { compact } from "~/views/bots/Usage";
import { cx } from "~/lib/cx";

/**
 * Analytics: a year of token use as a GitHub-style heat map (one square per
 * day, darker = more), with the basics beside it. Built to take more panels
 * (trends, providers, bots) as they arrive.
 */

interface Day { date: string; tokens: number; inputTokens: number; outputTokens: number; requests: number }

const WEEKS = 53;
const CELL = 12;
const GAP = 3;

export function Analytics() {
  const [days, setDays] = useState<Day[] | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Day | null>(null);

  useEffect(() => {
    http.get<{ days: Day[]; since: string | null }>(`/api/usage/history?days=${WEEKS * 7 + 7}`)
      .then((r) => { setDays(r.days); setSince(r.since); })
      .catch((e) => setError(e instanceof Error && /404/.test(e.message) ? "This runtime doesn't keep daily history yet (needs Mercury 1.5)." : String(e instanceof Error ? e.message : e)));
  }, []);

  const view = useMemo(() => (days ? layout(days) : null), [days]);
  const stats = useMemo(() => (days ? summarise(days) : null), [days]);

  if (error) return <p className="text-sm text-ink3">{error}</p>;
  if (!days || !view || !stats) return <div className="py-10 text-ink3"><Spinner size={18} /></div>;

  return (
    <section className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-3">
        <Tile label="Last 12 months" value={compact(stats.total)} sub="tokens" />
        <Tile label="Active days" value={String(stats.activeDays)} sub={`current streak ${stats.streak} day${stats.streak === 1 ? "" : "s"}`} />
        <Tile label="Busiest day" value={stats.best ? compact(stats.best.tokens) : "—"} sub={stats.best ? fmtDate(stats.best.date) : "no activity yet"} />
        <Tile label="Average active day" value={stats.activeDays ? compact(Math.round(stats.total / stats.activeDays)) : "—"} sub={`${compact(stats.requests)} requests in all`} />
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">Tokens per day</span>
          <span className="text-xs text-ink4">{since ? `Recorded since ${fmtDate(since)}` : "Recording starts today"}</span>
        </div>
        <div className="overflow-x-auto">
          <svg width={WEEKS * (CELL + GAP) + 28} height={7 * (CELL + GAP) + 18} role="img" aria-label="Token use per day over the last year" onMouseLeave={() => setHover(null)}>
            {view.months.map((m) => <text key={`${m.label}-${m.week}`} x={28 + m.week * (CELL + GAP)} y={10} className="fill-[rgb(var(--ink-4))] text-[10px]">{m.label}</text>)}
            {["Mon", "Wed", "Fri"].map((d, i) => <text key={d} x={0} y={18 + (1 + i * 2) * (CELL + GAP) + CELL - 2} className="fill-[rgb(var(--ink-4))] text-[10px]">{d}</text>)}
            {view.cells.map((c) => c.day && (
              <rect key={c.day.date} x={28 + c.week * (CELL + GAP)} y={16 + c.weekday * (CELL + GAP)} width={CELL} height={CELL} rx={3}
                className={cx(LEVEL_CLASS[c.level], hover?.date === c.day.date && "stroke-[rgb(var(--ink))]")} strokeWidth={1.2}
                onMouseEnter={() => setHover(c.day)}>
                <title>{`${fmtDate(c.day.date)}: ${c.day.tokens.toLocaleString()} tokens`}</title>
              </rect>
            ))}
          </svg>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-ink3">
          <span className="min-h-[18px]">
            {hover ? <><span className="text-ink">{fmtDate(hover.date)}</span> · {hover.tokens.toLocaleString()} tokens · {compact(hover.inputTokens)} in · {compact(hover.outputTokens)} out · {hover.requests} requests</> : "Hover a day for its numbers"}
          </span>
          <span className="flex items-center gap-1">Less {LEVEL_CLASS.map((cls, i) => <svg key={i} width={CELL} height={CELL}><rect width={CELL} height={CELL} rx={3} className={cls} /></svg>)} More</span>
        </div>
      </div>
      <p className="text-xs text-ink4">Counts every model request Mercury makes: chat, code, bots and channels. Days are in this computer's time zone.</p>
    </section>
  );
}

const LEVEL_CLASS = [
  "fill-[rgb(var(--ink)/0.07)]",
  "fill-[rgb(var(--accent)/0.3)]",
  "fill-[rgb(var(--accent)/0.5)]",
  "fill-[rgb(var(--accent)/0.75)]",
  "fill-[rgb(var(--accent))]",
];

/** Weeks as columns (Sunday first, like GitHub), the last column ending today. */
function layout(days: Day[]) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - end.getDay() - (WEEKS - 1) * 7);
  const values = days.map((d) => d.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const cells: Array<{ week: number; weekday: number; day: Day | null; level: number }> = [];
  const months: Array<{ label: string; week: number }> = [];
  let lastMonth = -1;
  for (let w = 0; w < WEEKS; w++) {
    for (let wd = 0; wd < 7; wd++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + wd);
      if (d > end) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const day = byDate.get(key) ?? { date: key, tokens: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      const level = day.tokens <= 0 ? 0 : day.tokens <= cuts[0] ? 1 : day.tokens <= cuts[1] ? 2 : day.tokens <= cuts[2] ? 3 : 4;
      cells.push({ week: w, weekday: wd, day, level });
      if (wd === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7) {
        lastMonth = d.getMonth();
        if (w < WEEKS - 2) months.push({ label: d.toLocaleString([], { month: "short" }), week: w });
      }
    }
  }
  return { cells, months };
}

function summarise(days: Day[]) {
  const recent = days.slice(-365);
  const total = recent.reduce((n, d) => n + d.tokens, 0);
  const requests = recent.reduce((n, d) => n + d.requests, 0);
  const active = recent.filter((d) => d.tokens > 0);
  const best = active.reduce<Day | null>((b, d) => (!b || d.tokens > b.tokens ? d : b), null);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].tokens > 0) streak++;
    else if (i === days.length - 1) continue; // today may not have started yet
    else break;
  }
  return { total, requests, activeDays: active.length, best, streak };
}

function fmtDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-ink4">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 truncate text-xs text-ink3">{sub}</div>
    </div>
  );
}
