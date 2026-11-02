import { Bot, Eye, Newspaper, PenLine, Search } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotSchedule, BotTier, BotTierId } from "~/api/types";
import { refreshBots } from "~/app/events";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { cx } from "~/lib/cx";
import { ModelPicker, ScheduleEditor, TierPicker, slugify } from "./BotForms";

/**
 * A new bot in one screen: start from what it's for, name it, say what it
 * does and when, and how much it may do. Everything can be changed later in
 * its Settings. A template only fills the fields; nothing is hidden.
 */

interface Template {
  id: string;
  label: string;
  blurb: string;
  icon: typeof Bot;
  description: string;
  persona: string;
  tier: BotTierId;
  schedules: BotSchedule[];
}

const TEMPLATES: Template[] = [
  {
    id: "researcher", label: "Researcher", blurb: "Looks things up and reports what it found.", icon: Search, tier: "readonly",
    description: "Researches topics on the web and reports clear, sourced findings.",
    persona: "You research what you're asked about using the web and the files you can read.\n\n- Lead with the answer, then the evidence, with links.\n- Say what you couldn't verify.\n- Close with bot_report: the findings in a few paragraphs. If a written report was asked for, deliver it as a .md file first.",
    schedules: [],
  },
  {
    id: "monitor", label: "Monitor", blurb: "Checks something on a schedule and tells you only when it changed.", icon: Eye, tier: "readonly",
    description: "Watches for changes and reports only what's new.",
    persona: "You check one thing on a schedule and report only what changed since last time.\n\n- Use your working state (bot_state) to remember what you saw last.\n- If nothing changed, call bot_no_update — never write a status note.\n- If something changed, close with bot_report: what changed, in one or two sentences, with a link.",
    schedules: [{ name: "check", cron: "0 * * * *", prompt: "Check for changes since your last run. Report only what's new; otherwise call bot_no_update." }],
  },
  {
    id: "writer", label: "Writer", blurb: "Drafts articles, posts or reports and delivers the file.", icon: PenLine, tier: "builder",
    description: "Writes drafts and delivers them as files.",
    persona: "You write what you're asked for: articles, posts, summaries, reports.\n\n- Write in plain, direct sentences in the owner's voice.\n- Save the draft in your workspace as a .md file, deliver it with bot_deliver (final: true for the finished piece), then close with bot_report saying what you delivered.",
    schedules: [],
  },
  {
    id: "digest", label: "Daily digest", blurb: "Every morning, a short brief on a topic you choose.", icon: Newspaper, tier: "readonly",
    description: "Sends a short morning brief.",
    persona: "Each morning you prepare a short brief on the owner's topics.\n\n- Five items at most, each one line with a link, newest first.\n- Skip anything you already reported (check your recent runs).\n- Close with bot_report containing the brief. If there's genuinely nothing new, call bot_no_update.",
    schedules: [{ name: "morning", cron: "0 9 * * *", prompt: "Prepare today's brief." }],
  },
  {
    id: "blank", label: "Start from scratch", blurb: "An empty bot you describe yourself.", icon: Bot, tier: "readonly",
    description: "", persona: "", schedules: [],
  },
];

export function CreateBot({ onCreated, onCancel, existingIds }: { onCreated: (id: string) => void; onCancel: () => void; existingIds: string[] }) {
  const [template, setTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [tier, setTier] = useState<BotTierId>("readonly");
  const [schedules, setSchedules] = useState<BotSchedule[]>([]);
  const [model, setModel] = useState<{ provider?: string; model?: string } | undefined>(undefined);
  const [budget, setBudget] = useState("1000000");
  const [tiers, setTiers] = useState<BotTier[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.bots.tiers().then(setTiers).catch(() => {}); }, []);

  function pick(t: Template) {
    setTemplate(t);
    setDescription(t.description);
    setPersona(t.persona);
    setTier(t.tier);
    setSchedules(t.schedules);
    if (!name && t.id !== "blank") setName(t.label);
  }

  const id = uniqueId(slugify(name || "bot"), existingIds);
  const budgetNum = Number(budget.replace(/[,\s_]/g, ""));
  const problem = !name.trim() ? "Give it a name."
    : !persona.trim() ? "Say how it should work (its instructions)."
      : !Number.isFinite(budgetNum) || budgetNum < 10_000 ? "The daily budget must be at least 10,000 tokens."
        : schedules.find((s) => !s.prompt.trim()) ? "Every schedule needs instructions."
          : null;

  async function create() {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api.bots.create({
        id, name: name.trim(), description: description.trim() || undefined, persona: persona.trim(), tier,
        manifest: { ...(model ? { model } : {}), autonomy: { dailyTokenBudget: Math.round(budgetNum) } },
      });
      // Schedules go through the editor's path so they're registered with the scheduler at once.
      if (schedules.length) await api.bots.update(id, { schedules: schedules.map((s) => ({ ...s, prompt: s.prompt.trim() })) });
      await refreshBots();
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!template) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">New bot</h1>
          <p className="mt-1 text-sm text-ink3">A bot works on its own, on a schedule or when you message it, and reports back to your inbox. Pick a starting point; you can change everything.</p>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button key={t.id} onClick={() => pick(t)} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-line-strong">
              <t.icon size={18} className="mt-0.5 shrink-0 text-ink2" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium text-ink">{t.label}</span>
                <span className="block text-xs text-ink3">{t.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        <div><Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button></div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-8 py-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">New bot · {template.label}</h1>
            <p className="mt-1 text-sm text-ink3">Everything here can be changed later in the bot's Settings.</p>
          </div>

          <Section title="Name" hint={`Its id will be ${id}.`}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rust Watcher" autoFocus aria-label="Name" />
          </Section>

          <Section title="What it's for" hint="One line, shown in the bot list.">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Watches Hacker News for Rust posts" aria-label="Description" />
          </Section>

          <Section title="How it works" hint="Its instructions. Say what a good result is, and when there's nothing to report.">
            <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={8}
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink4" aria-label="Instructions"
              placeholder="You… When you finish, close with bot_report; if there's nothing new, call bot_no_update." />
          </Section>

          <Section title="When it runs">
            <ScheduleEditor value={schedules} onChange={setSchedules} />
          </Section>

          <Section title="What it may do">
            <TierPicker value={tier} onChange={setTier} tiers={tiers} />
          </Section>

          <Section title="Model and budget">
            <div className="flex flex-col gap-2.5">
              <ModelPicker value={model} onChange={setModel} />
              <label className="flex items-center gap-2 text-sm text-ink2">
                <span className="w-40 shrink-0">Daily token budget</span>
                <Input value={budget} onChange={(e) => setBudget(e.target.value)} mono className="h-9 w-44" aria-label="Daily token budget" />
                <span className="text-xs text-ink4">It pauses until tomorrow when it's spent.</span>
              </label>
            </div>
          </Section>
        </div>
      </div>
      {/* Always on screen: only the form above scrolls. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-8 py-3">
        <Button variant="ghost" onClick={() => setTemplate(null)}>Back</Button>
        <span className="flex-1 text-right text-sm text-red">{error}</span>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void create()}>Create bot</Button>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className={cx("flex flex-col gap-2")}>
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint && <p className="text-xs text-ink3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}
