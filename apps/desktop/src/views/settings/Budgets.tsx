import { useEffect, useState } from "react";
import { ApiError, http } from "~/api/client";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Segmented, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { compact } from "~/views/bots/Usage";

/**
 * Budgets: how many tokens Mercury may use a day, when Token Saver steps
 * in, and the caps for bots. Saves apply at once, no restart.
 */

export interface BudgetState {
  daily: { budget: number; used: number; remaining: number; percentage: number };
  saver: { state: "off" | "on" | "auto"; autoEnabled: boolean; autoThreshold: number; savedToday: number; savedLifetime: number };
  bots: { enabled: boolean; perBot: number; fleet: number };
}

type BudgetPatch = { dailyBudget?: number; saver?: { manual?: boolean; autoEnabled?: boolean; autoThreshold?: number }; bots?: { perBot?: number; fleet?: number } };

const DAILY_PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
const THRESHOLDS = ["50", "75", "90"] as const;

/** "2M", "750k", "1,500,000" → tokens; null when it isn't a number. */
export function parseTokens(text: string): number | null {
  const m = text.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function BudgetsSettings() {
  const [state, setState] = useState<BudgetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    http.get<BudgetState>("/api/budget")
      .then(setState)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This runtime can't change budgets from here yet. Update Mercury, or send /budget set <tokens> in a chat." : e instanceof Error ? e.message : String(e)));
  }, []);

  async function save(patch: BudgetPatch): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      setState(await http.put<BudgetState>("/api/budget", patch));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!state) return error ? <p className="text-sm text-ink3">{error}</p> : <div className="py-10 text-ink3"><Spinner size={18} /></div>;
  const { daily, saver, bots } = state;
  const ratio = daily.budget > 0 ? Math.min(1, daily.used / daily.budget) : 0;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink3">Tokens are what the models count. When Mercury reaches the daily budget it stops and tells you: raise the budget here, or send /budget override in a chat to let one more request through.</p>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Daily budget</h3>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink">{compact(daily.used)} <span className="text-ink3">of {compact(daily.budget)} used today</span></span>
            <span className="font-mono text-xs text-ink3">{daily.percentage}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]" role="meter" aria-valuemin={0} aria-valuemax={daily.budget} aria-valuenow={daily.used} aria-label="Tokens used today">
            <div className={cx("h-full rounded-full", ratio >= 0.9 ? "bg-red" : ratio >= 0.75 ? "bg-amber" : "bg-accent")} style={{ width: `${ratio * 100}%` }} />
          </div>
          <TokenField
            id="budget-daily"
            label="Tokens a day"
            value={daily.budget}
            min={1_000}
            presets={DAILY_PRESETS}
            saving={saving}
            onSave={(n) => save({ dailyBudget: n })}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Token Saver</h3>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          <Row title="On now" hint={saver.state === "auto" ? "On by itself: you're past the threshold today." : "Shorter answers, fewer steps, a smaller history. Turn on for a cheap day."}>
            <Switch id="saver-manual" checked={saver.state !== "off"} disabled={saving} onCheckedChange={(v) => void save({ saver: { manual: v } })} />
          </Row>
          <Row title="Turn on by itself" hint="When today's use passes a share of the daily budget.">
            <Switch id="saver-auto" checked={saver.autoEnabled} disabled={saving} onCheckedChange={(v) => void save({ saver: { autoEnabled: v } })} />
          </Row>
          {saver.autoEnabled && (
            <Row title="At" hint="of the daily budget.">
              <Segmented
                value={THRESHOLDS.find((t) => Number(t) === saver.autoThreshold) ?? ("" as (typeof THRESHOLDS)[number])}
                onChange={(v) => void save({ saver: { autoThreshold: Number(v) } })}
                options={THRESHOLDS.map((t) => ({ value: t, label: `${t}%` }))}
              />
            </Row>
          )}
          <div className="px-4 py-2.5 text-xs text-ink3">Saved about {compact(saver.savedToday)} tokens today, {compact(saver.savedLifetime)} in all.</div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Bots</h3>
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface px-4 py-3">
          {!bots.enabled && <p className="text-xs text-ink3">Bots are off. These caps apply once you turn them on.</p>}
          <TokenField id="budget-bot" label="Each bot, a day" hint="For bots that don't set their own. 0 means no cap." value={bots.perBot} min={0} saving={saving} onSave={(n) => save({ bots: { perBot: n } })} />
          <TokenField id="budget-fleet" label="All bots together, a day" hint="Every bot pauses until tomorrow when it's reached. 0 means no cap." value={bots.fleet} min={0} saving={saving} onSave={(n) => save({ bots: { fleet: n } })} />
        </div>
      </section>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-sm text-ink">{title}</div>
        <div className="text-xs text-ink3">{hint}</div>
      </div>
      {children}
    </div>
  );
}

/** A token amount: type "2M" or "750k", or pick a preset. Saves on Enter or Save. */
function TokenField({ id, label, hint, value, min, presets, saving, onSave }: {
  id: string; label: string; hint?: string; value: number; min: number; presets?: number[]; saving: boolean; onSave: (n: number) => Promise<boolean>;
}) {
  const [text, setText] = useState(value.toLocaleString());
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(value.toLocaleString()); }, [value]);
  const parsed = parseTokens(text);
  const dirty = parsed !== value;

  async function commit(n: number | null = parsed) {
    setSaved(false);
    if (n === null) return setProblem("Type a number, like 2M or 750k.");
    if (n < min) return setProblem(`At least ${min.toLocaleString()} tokens.`);
    setProblem(null);
    if (await onSave(n)) setSaved(true);
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm text-ink">{label}</label>
      {hint && <div className="-mt-1.5 text-xs text-ink3">{hint}</div>}
      <div className="flex items-center gap-2">
        <Input id={id} mono value={text} inputMode="numeric" className="max-w-[180px]" onChange={(e) => { setText(e.target.value); setSaved(false); setProblem(null); }} onKeyDown={(e) => { if (e.key === "Enter" && dirty) void commit(); }} aria-invalid={!!problem} />
        <span className="text-xs text-ink4">tokens</span>
        {dirty && <Button size="sm" variant="primary" disabled={saving} onClick={() => void commit()}>Save</Button>}
        {saved && !dirty && <span className="text-xs text-accent">Saved</span>}
      </div>
      {presets && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p} type="button" disabled={saving} onClick={() => { setText(p.toLocaleString()); void commit(p); }}
              className={cx("rounded-full border px-2.5 py-0.5 font-mono text-2xs", p === value ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-ink3 hover:border-line-strong hover:text-ink")}>
              {compact(p)}
            </button>
          ))}
        </div>
      )}
      {problem && <div className="text-xs text-red" role="alert">{problem}</div>}
    </div>
  );
}
