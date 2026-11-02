import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotSchedule, BotTier, BotTierId, ModelsResponse } from "~/api/types";
import { Input } from "~/components/ui/Input";
import { cx } from "~/lib/cx";

/**
 * The pieces the bot wizard and a bot's Settings share: who it may act as
 * (permission tier, in plain words), when it runs (schedules with presets),
 * and which model it thinks with.
 */

/** Tiers in plain words: what the bot can and can't do. Falls back to the runtime's own text. */
const TIER_WORDS: Record<BotTierId, { title: string; can: string; cant: string }> = {
  readonly: { title: "Read only", can: "Browse the web, search, read files, message other bots, report back.", cant: "Can't write files or run commands." },
  builder: { title: "Writes files", can: "Everything in Read only, plus create and edit files in its own folder.", cant: "Can't run commands or delete anything." },
  operator: { title: "Runs commands", can: "Everything in Writes files, plus run commands inside its own folder.", cant: "Can't delete files or touch the rest of your computer." },
  full: { title: "Full access", can: "Everything, including deleting files and reading and writing your whole home folder.", cant: "Only for automation you fully trust." },
};

export function TierPicker({ value, onChange, tiers }: { value: BotTierId | "custom" | undefined; onChange: (t: BotTierId) => void; tiers?: BotTier[] }) {
  const ids: BotTierId[] = (tiers?.map((t) => t.id) ?? (Object.keys(TIER_WORDS) as BotTierId[]));
  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Permissions">
      {value === "custom" && (
        <p className="rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-xs text-ink2">
          This bot's permissions were edited by hand (its permissions.yaml). Picking a level below replaces them.
        </p>
      )}
      {ids.map((id) => {
        const w = TIER_WORDS[id];
        const on = value === id;
        return (
          <button key={id} role="radio" aria-checked={on} onClick={() => onChange(id)}
            className={cx("flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors", on ? "border-accent/60 bg-accent/[0.06]" : "border-line hover:border-line-strong")}>
            <span className={cx("mt-1 h-3.5 w-3.5 shrink-0 rounded-full border", on ? "border-[5px] border-accent" : "border-line-strong")} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                {w?.title ?? id}
                {id === "readonly" && <span className="text-xs font-normal text-ink4">recommended</span>}
                {id === "full" && <ShieldAlert size={13} className="text-amber" aria-hidden="true" />}
              </span>
              <span className="block text-xs text-ink3">{w ? `${w.can} ${w.cant}` : tiers?.find((t) => t.id === id)?.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Common schedules, in words. Anything else is a custom cron. */
export const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 4 hours", cron: "0 */4 * * *" },
  { label: "Every morning at 9", cron: "0 9 * * *" },
  { label: "Weekdays at 9", cron: "0 9 * * 1-5" },
  { label: "Every evening at 6", cron: "0 18 * * *" },
  { label: "Mondays at 9", cron: "0 9 * * 1" },
];

export function describeCron(cron: string): string {
  return SCHEDULE_PRESETS.find((p) => p.cron === cron.trim())?.label ?? cron;
}

/** Runs more often than every 15 minutes are slowed to that by Mercury. */
export function tooFrequent(cron: string): boolean {
  const minute = cron.trim().split(/\s+/)[0] ?? "";
  if (minute === "*") return true;
  const step = /^\*\/(\d+)$/.exec(minute);
  return !!step && Number(step[1]) < 15;
}

export function ScheduleEditor({ value, onChange }: { value: BotSchedule[]; onChange: (s: BotSchedule[]) => void }) {
  const set = (i: number, patch: Partial<BotSchedule>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="flex flex-col gap-2.5">
      {value.length === 0 && <p className="text-sm text-ink3">No schedule: it runs when you message it or press Run now.</p>}
      {value.map((s, i) => {
        const preset = SCHEDULE_PRESETS.some((p) => p.cron === s.cron);
        return (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <select value={preset ? s.cron : "custom"} onChange={(e) => set(i, { cron: e.target.value === "custom" ? s.cron || "0 9 * * *" : e.target.value })}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink" aria-label="When">
                {SCHEDULE_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
                <option value="custom">Custom (cron)…</option>
              </select>
              {!preset && <Input value={s.cron} onChange={(e) => set(i, { cron: e.target.value })} mono className="h-8 w-40" aria-label="Cron expression" placeholder="0 9 * * *" />}
              <span className="flex-1" />
              <button onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded p-1.5 text-ink4 hover:text-red" aria-label="Remove schedule"><Trash2 size={14} /></button>
            </div>
            <textarea value={s.prompt} onChange={(e) => set(i, { prompt: e.target.value })} rows={2} placeholder="What to do each time, and when to report nothing (e.g. “Check Hacker News for posts about Rust. Report only new ones; otherwise nothing new.”)"
              className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink4" aria-label="Instructions" />
            {tooFrequent(s.cron) && <p className="text-xs text-amber">Mercury runs a routine at most every 15 minutes, so this runs every 15 minutes.</p>}
          </div>
        );
      })}
      <div>
        <button onClick={() => onChange([...value, { name: nextName(value), cron: "0 9 * * *", prompt: "" }])} className="flex items-center gap-1.5 text-sm text-ink2 hover:text-ink">
          <Plus size={14} /> Add a schedule
        </button>
      </div>
    </div>
  );
}

function nextName(list: BotSchedule[]): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? "routine" : `routine-${i}`;
    if (!list.some((s) => s.name === name)) return name;
  }
}

/** Which model the bot thinks with; empty = Mercury's default. */
export function ModelPicker({ value, onChange }: { value: { provider?: string; model?: string } | undefined; onChange: (v: { provider?: string; model?: string } | undefined) => void }) {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  useEffect(() => { void api.chat.models().then(setModels).catch(() => setModels(null)); }, []);
  const key = value?.provider ? `${value.provider}::${value.model ?? ""}` : "";
  return (
    <select value={key} onChange={(e) => {
      const v = e.target.value;
      if (!v) { onChange(undefined); return; }
      const [provider, model] = v.split("::");
      onChange({ provider, model: model || undefined });
    }} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink" aria-label="Model">
      <option value="">Mercury's default model{models?.current ? ` (${models.current.model})` : ""}</option>
      {(models?.providers ?? []).filter((p) => p.available).map((p) => (
        <option key={`${p.name}::${p.model}`} value={`${p.name}::${p.model}`}>{p.label ?? p.name} · {p.model}</option>
      ))}
    </select>
  );
}

/** A bot id from its name: lowercase, dashes, unique-ish. */
export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 30).replace(/^-|-$/g, "");
  return /^[a-z]/.test(s) ? s : `bot-${s || "new"}`;
}
