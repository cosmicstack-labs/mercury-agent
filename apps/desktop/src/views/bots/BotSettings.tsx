import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotManifest, BotSchedule, BotStatus, BotTier, BotTierId } from "~/api/types";
import { refreshBots } from "~/app/events";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Spinner } from "~/components/ui/bits";
import { ModelPicker, PersonaBuilderButton, ScheduleEditor, TierPicker } from "./BotForms";

/**
 * Everything about a bot that the owner decides, on one page: its name and
 * line, its instructions, when it runs, what it may do, its model and limits.
 * Each section saves on its own; nothing waits for a restart.
 */
export function BotSettings({ id, status }: { id: string; status: BotStatus | null }) {
  const [bot, setBot] = useState<BotManifest | null>(null);
  const [persona, setPersona] = useState<string | null>(null);
  const [tiers, setTiers] = useState<BotTier[] | undefined>(undefined);

  async function load() {
    const [b, p] = await Promise.all([api.bots.get(id).then((r) => r.bot).catch(() => null), api.bots.persona(id).catch(() => "")]);
    setBot(b);
    setPersona(p);
  }
  useEffect(() => { setBot(null); setPersona(null); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void api.bots.tiers().then(setTiers).catch(() => {}); }, []);

  if (!bot || persona === null) return <div className="flex h-40 items-center justify-center text-ink3"><Spinner size={18} /></div>;

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <Basics bot={bot} onSaved={load} />
      <Card title="How it works" hint="Its instructions. Say what a good result is, and when there's nothing to report.">
        <PersonaEditor id={id} name={bot.name} initial={persona} />
      </Card>
      <SchedulesCard bot={bot} onSaved={load} />
      <Card title="What it may do">
        <TierCard id={id} tier={status?.tier} tiers={tiers} />
      </Card>
      <Limits bot={bot} onSaved={load} />
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <p className="text-xs text-ink3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Save button + its result, shared by every section. */
function useSave() {
  const [state, setState] = useState<{ busy: boolean; note: string | null; ok: boolean }>({ busy: false, note: null, ok: true });
  async function run(fn: () => Promise<unknown>, done = "Saved.") {
    setState({ busy: true, note: null, ok: true });
    try {
      await fn();
      setState({ busy: false, note: done, ok: true });
      void refreshBots();
      setTimeout(() => setState((s) => (s.note === done ? { ...s, note: null } : s)), 2500);
    } catch (e) {
      setState({ busy: false, note: e instanceof Error ? e.message : String(e), ok: false });
    }
  }
  const footer = (onClick: () => void, disabled = false, label = "Save") => (
    <div className="flex items-center justify-end gap-3">
      {state.note && <span className={state.ok ? "text-xs text-ok" : "text-xs text-red"}>{state.note}</span>}
      <Button size="sm" variant="primary" loading={state.busy} disabled={disabled} onClick={onClick}>{label}</Button>
    </div>
  );
  return { run, footer };
}

function Basics({ bot, onSaved }: { bot: BotManifest; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description ?? "");
  const { run, footer } = useSave();
  const changed = name.trim() !== bot.name || description.trim() !== (bot.description ?? "");
  return (
    <Card title="Name">
      <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it's for, in one line" aria-label="Description" />
      {footer(() => void run(async () => { await api.bots.update(bot.id, { name: name.trim(), description: description.trim() }); await onSaved(); }), !changed || !name.trim())}
    </Card>
  );
}

function PersonaEditor({ id, name, initial }: { id: string; name: string; initial: string }) {
  const [text, setText] = useState(initial);
  const { run, footer } = useSave();
  return (
    <>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
        className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-ink" aria-label="Instructions" />
      <PersonaBuilderButton text={text} name={name} onBuilt={setText} />
      {footer(() => void run(() => api.bots.setPersona(id, text)), text.trim() === initial.trim() || !text.trim())}
    </>
  );
}

function SchedulesCard({ bot, onSaved }: { bot: BotManifest; onSaved: () => Promise<void> }) {
  const [schedules, setSchedules] = useState<BotSchedule[]>(bot.schedules ?? []);
  const { run, footer } = useSave();
  const changed = JSON.stringify(schedules) !== JSON.stringify(bot.schedules ?? []);
  const empty = schedules.some((s) => !s.prompt.trim());
  return (
    <Card title="When it runs" hint="Changes apply right away. Between runs of one schedule there are always at least 15 minutes.">
      <ScheduleEditor value={schedules} onChange={setSchedules} />
      {footer(() => void run(async () => { await api.bots.update(bot.id, { schedules: schedules.map((s) => ({ ...s, prompt: s.prompt.trim() })) }); await onSaved(); }), !changed || empty)}
    </Card>
  );
}

function TierCard({ id, tier, tiers }: { id: string; tier: BotTierId | "custom" | undefined; tiers?: BotTier[] }) {
  const [value, setValue] = useState<BotTierId | "custom" | undefined>(tier);
  useEffect(() => { setValue(tier); }, [tier]);
  const { run, footer } = useSave();
  return (
    <>
      <TierPicker value={value} onChange={setValue} tiers={tiers} />
      {footer(() => void run(() => api.bots.setTier(id, value as BotTierId)), value === tier || value === "custom" || value === undefined)}
    </>
  );
}

function Limits({ bot, onSaved }: { bot: BotManifest; onSaved: () => Promise<void> }) {
  const [model, setModel] = useState(bot.model);
  const [budget, setBudget] = useState(String(bot.autonomy?.dailyTokenBudget ?? ""));
  const [steps, setSteps] = useState(String(bot.autonomy?.maxSteps ?? ""));
  const [learn, setLearn] = useState(bot.memory?.learn !== false);
  const { run, footer } = useSave();
  const num = (s: string) => (s.trim() ? Number(s.replace(/[,\s_]/g, "")) : undefined);
  const bad = [num(budget), num(steps)].some((n) => n !== undefined && (!Number.isFinite(n) || n <= 0));
  return (
    <Card title="Model and limits">
      <label className="flex flex-col gap-1 text-xs text-ink3">Model<ModelPicker value={model} onChange={setModel} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink3">Daily token budget<Input value={budget} onChange={(e) => setBudget(e.target.value)} mono placeholder="Fleet default" /></label>
        <label className="flex flex-col gap-1 text-xs text-ink3">Steps per run<Input value={steps} onChange={(e) => setSteps(e.target.value)} mono placeholder="25" /></label>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex-1 text-sm text-ink2">Learn from its runs (remembers useful facts for next time)</span>
        <Switch checked={learn} onCheckedChange={setLearn} label="Learn from runs" />
      </div>
      {footer(() => void run(async () => {
        await api.bots.update(bot.id, {
          // null clears a model choice: back to Mercury's default.
          model: (model ?? null) as BotManifest["model"],
          autonomy: { ...(bot.autonomy ?? {}), dailyTokenBudget: num(budget), maxSteps: num(steps) },
          memory: { ...(bot.memory ?? {}), learn },
        });
        await onSaved();
      }), bad)}
    </Card>
  );
}
