import { Bot, Crown, Eye, Newspaper, PenLine, Search, Users, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotPlan, BotSchedule, BotTier, BotTierId, CrewSpec } from "~/api/types";
import { refreshBots } from "~/app/events";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { CrewEditor, ModelPicker, PersonaBuilderButton, ScheduleEditor, TierPicker, slugify } from "./BotForms";

/**
 * A new bot: start from what it's for, say what it does and when, how much
 * it may do — and whether it works alone or leads a fleet. "Let Mercury
 * decide" (the default) looks at the job and proposes one bot or a small team;
 * you review the proposal, edit the crew, and only then is anything created.
 * Everything can be changed later in the bot's Settings.
 */

type Structure = "auto" | "solo" | "fleet-auto" | "fleet-manual";

interface Template {
  id: string;
  label: string;
  blurb: string;
  icon: typeof Bot;
  description: string;
  persona: string;
  tier: BotTierId;
  schedules: BotSchedule[];
  structure: Structure;
}

const TEMPLATES: Template[] = [
  {
    id: "researcher", label: "Researcher", blurb: "Looks things up and reports what it found.", icon: Search, tier: "readonly", structure: "auto",
    description: "Researches topics on the web and reports clear, sourced findings.",
    persona: "You research what you're asked about using the web and the files you can read.\n\n- Lead with the answer, then the evidence, with links.\n- Say what you couldn't verify.\n- Close with bot_report: the findings in a few paragraphs. If a written report was asked for, deliver it as a .md file first.",
    schedules: [],
  },
  {
    id: "monitor", label: "Monitor", blurb: "Checks something on a schedule and tells you only when it changed.", icon: Eye, tier: "readonly", structure: "solo",
    description: "Watches for changes and reports only what's new.",
    persona: "You check one thing on a schedule and report only what changed since last time.\n\n- Use your working state (bot_state) to remember what you saw last.\n- If nothing changed, call bot_no_update — never write a status note.\n- If something changed, close with bot_report: what changed, in one or two sentences, with a link.",
    schedules: [{ name: "check", cron: "0 * * * *", prompt: "Check for changes since your last run. Report only what's new; otherwise call bot_no_update." }],
  },
  {
    id: "writer", label: "Writer", blurb: "Drafts articles, posts or reports and delivers the file.", icon: PenLine, tier: "builder", structure: "auto",
    description: "Writes drafts and delivers them as files.",
    persona: "You write what you're asked for: articles, posts, summaries, reports.\n\n- Write in plain, direct sentences in the owner's voice.\n- Save the draft in your workspace as a .md file, deliver it with bot_deliver (final: true for the finished piece), then close with bot_report saying what you delivered.",
    schedules: [],
  },
  {
    id: "digest", label: "Daily digest", blurb: "Every morning, a short brief on a topic you choose.", icon: Newspaper, tier: "readonly", structure: "solo",
    description: "Sends a short morning brief.",
    persona: "Each morning you prepare a short brief on the owner's topics.\n\n- Five items at most, each one line with a link, newest first.\n- Skip anything you already reported (check your recent runs).\n- Close with bot_report containing the brief. If there's genuinely nothing new, call bot_no_update.",
    schedules: [{ name: "morning", cron: "0 9 * * *", prompt: "Prepare today's brief." }],
  },
  {
    id: "team", label: "A team (fleet)", blurb: "A lead that hands parts of the job to specialists, e.g. research → write → check.", icon: Users, tier: "builder", structure: "fleet-auto",
    description: "Leads a small team of specialists.",
    persona: "You lead a small team. Break each job into parts, hand each part to the right crew member with a clear goal and what \"done\" means, then combine what they hand back into one result.\n\n- Close with bot_report: the combined result, and the files delivered.",
    schedules: [],
  },
  {
    id: "blank", label: "Start from scratch", blurb: "An empty bot you describe yourself.", icon: Bot, tier: "readonly", structure: "auto",
    description: "", persona: "", schedules: [],
  },
];

const STRUCTURES: Array<{ id: Structure; title: string; body: string; icon: typeof Bot }> = [
  { id: "auto", title: "Let Mercury decide", body: "It looks at the job and suggests one bot or a small team. You review it before anything is created.", icon: Wand2 },
  { id: "solo", title: "One bot", body: "Does the whole job itself. Cheapest, and right for most jobs.", icon: Bot },
  { id: "fleet-auto", title: "A fleet — Mercury designs the team", body: "This bot leads; Mercury proposes 2–5 specialists for it to hand work to.", icon: Crown },
  { id: "fleet-manual", title: "A fleet — I'll choose the team", body: "This bot leads the crew you write here.", icon: Users },
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
  const [structure, setStructure] = useState<Structure>("auto");
  const [crew, setCrew] = useState<CrewSpec[]>([]);
  const [maxCrew, setMaxCrew] = useState(6);
  const [tiers, setTiers] = useState<BotTier[] | undefined>(undefined);
  /** Mercury's proposal, once asked for: the review screen shows it. */
  const [plan, setPlan] = useState<BotPlan | null>(null);
  const [busy, setBusy] = useState<"plan" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.bots.tiers().then(setTiers).catch(() => {}); }, []);

  function pick(t: Template) {
    setTemplate(t);
    setDescription(t.description);
    setPersona(t.persona);
    setTier(t.tier);
    setSchedules(t.schedules);
    setStructure(t.structure);
    if (!name && t.id !== "blank") setName(t.label === "A team (fleet)" ? "" : t.label);
  }

  const id = uniqueId(slugify(name || "bot"), existingIds);
  const budgetNum = Number(budget.replace(/[,\s_]/g, ""));
  const formProblem = !name.trim() ? "Give it a name."
    : !persona.trim() ? "Say how it should work (its instructions)."
      : !Number.isFinite(budgetNum) || budgetNum < 10_000 ? "The daily budget must be at least 10,000 tokens."
        : schedules.find((s) => !s.prompt.trim()) ? "Every schedule needs instructions."
          : structure === "fleet-manual" && crew.filter((c) => c.name.trim()).length === 0 ? "Add at least one crew member, or pick another option."
            : null;
  const crewProblem = (list: CrewSpec[]) => list.find((c) => !c.name.trim() || !c.persona.trim()) ? "Every crew member needs a name and instructions." : null;

  async function askMercury(fleet: boolean) {
    if (formProblem) { setError(formProblem); return; }
    setBusy("plan");
    setError(null);
    try {
      const r = await api.bots.plan({ name: name.trim(), description: description.trim(), persona: persona.trim(), ...(fleet ? { fleet: true } : {}) });
      setMaxCrew(r.maxCrew);
      if (fleet && r.plan.shape !== "fleet") {
        setError("Mercury couldn't design a team for this right now. Try again, or choose the team yourself.");
        return;
      }
      setPlan(r.plan);
      setCrew(r.plan.crew);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function create(asFleet: boolean, team: CrewSpec[]) {
    const problem = formProblem ?? (asFleet ? crewProblem(team) : null);
    if (problem) { setError(problem); return; }
    setBusy("create");
    setError(null);
    try {
      await api.bots.create({
        id, name: name.trim(), description: description.trim() || undefined, persona: persona.trim(), tier,
        manifest: { ...(model ? { model } : {}), autonomy: { dailyTokenBudget: Math.round(budgetNum) } },
      });
      if (asFleet) {
        await api.bots.promote(id);
        // Crew inherit the lead's permission level; their ids are unique next to every bot's.
        const taken = [...existingIds, id];
        for (const c of team.filter((m) => m.name.trim())) {
          const crewId = uniqueId(slugify(c.name), taken);
          taken.push(crewId);
          await api.bots.addCrew(id, { id: crewId, name: c.name.trim(), description: c.description.trim(), persona: c.persona.trim() });
        }
      }
      // Schedules go through the editor's path so they're registered with the scheduler at once.
      if (schedules.length) await api.bots.update(id, { schedules: schedules.map((s) => ({ ...s, prompt: s.prompt.trim() })) });
      await refreshBots();
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ── 1. What it's for ────────────────────────────────────────────────
  if (!template) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">New bot</h1>
          <p className="mt-1 text-sm text-ink3">A bot works on its own, on a schedule or when you message it, and reports back to your inbox. It can work alone, or lead a fleet of specialist bots. Pick a starting point; you can change everything.</p>
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

  // ── 3. Mercury's proposal ───────────────────────────────────────────
  if (plan) {
    const fleet = plan.shape === "fleet";
    return (
      <Frame
        footer={<>
          <Button variant="ghost" onClick={() => { setPlan(null); setError(null); }}>Back</Button>
          <span className="flex-1 text-right text-sm text-red">{error}</span>
          <Button variant="primary" loading={busy === "create"} onClick={() => void create(fleet, crew)}>{fleet ? `Create the fleet (${crew.filter((c) => c.name.trim()).length + 1} bots)` : "Create bot"}</Button>
        </>}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{fleet ? `Mercury suggests a fleet of ${crew.length + 1}` : "Mercury suggests one bot"}</h1>
          <p className="mt-1 text-sm text-ink2">{plan.reason}</p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
          {fleet ? <Crown size={18} className="shrink-0 text-amber" aria-hidden="true" /> : <Bot size={18} className="shrink-0 text-ink2" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{name}{fleet && <span className="ml-2 text-xs font-normal text-ink3">lead</span>}</div>
            <div className="truncate text-xs text-ink3">{description || "Your instructions"}</div>
          </div>
        </div>

        {fleet ? (
          <Section title="The crew" hint={`They work for ${name}: it hands them parts of the job and combines what they send back. Edit, remove or add members (up to ${maxCrew}).`}>
            <CrewEditor value={crew} onChange={setCrew} max={maxCrew} />
            <div><button onClick={() => { setPlan({ ...plan, shape: "solo", crew: [] }); setCrew([]); }} className="text-sm text-ink3 hover:text-ink">Make it one bot instead</button></div>
          </Section>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink3">One bot is the cheapest setup: every hand-off in a fleet is an extra run.</p>
            <div><Button variant="outline" size="sm" loading={busy === "plan"} onClick={() => void askMercury(true)}><Crown size={13} /> Make it a fleet anyway</Button></div>
          </div>
        )}
      </Frame>
    );
  }

  // ── 2. The bot itself ───────────────────────────────────────────────
  const needsPlan = structure === "auto" || structure === "fleet-auto";
  return (
    <Frame
      footer={<>
        <Button variant="ghost" onClick={() => setTemplate(null)}>Back</Button>
        <span className="flex-1 text-right text-sm text-red">{error}</span>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {needsPlan ? (
          <Button variant="primary" loading={busy === "plan"} onClick={() => void askMercury(structure === "fleet-auto")}>
            {busy === "plan" ? "Mercury is planning…" : "Continue"}
          </Button>
        ) : (
          <Button variant="primary" loading={busy === "create"} onClick={() => void create(structure === "fleet-manual", crew)}>
            {structure === "fleet-manual" ? `Create the fleet (${crew.filter((c) => c.name.trim()).length + 1} bots)` : "Create bot"}
          </Button>
        )}
      </>}
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">New bot · {template.label}</h1>
        <p className="mt-1 text-sm text-ink3">Everything here can be changed later in the bot's Settings.</p>
      </div>

      <Section title="Name" hint={`Its id will be ${id}.`}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={template.id === "team" ? "e.g. Newsroom" : "e.g. Rust Watcher"} autoFocus aria-label="Name" />
      </Section>

      <Section title="What it's for" hint="One line, shown in the bot list.">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Watches Hacker News for Rust posts" aria-label="Description" />
      </Section>

      <Section title="How it works" hint="Its instructions, in your own words. Say what a good result is, and when there's nothing to report.">
        <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={8}
          className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink4" aria-label="Instructions"
          placeholder="You… When you finish, close with bot_report; if there's nothing new, call bot_no_update." />
        <PersonaBuilderButton text={persona} name={name} onBuilt={setPersona} />
      </Section>

      <Section title="Alone or a fleet" hint="A fleet is a lead bot that hands parts of the job to specialist crew bots.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Alone or a fleet">
          {STRUCTURES.map((s) => (
            <button key={s.id} role="radio" aria-checked={structure === s.id} onClick={() => setStructure(s.id)}
              className={cx("flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors", structure === s.id ? "border-accent/60 bg-accent/[0.06]" : "border-line hover:border-line-strong")}>
              <s.icon size={16} className={cx("mt-0.5 shrink-0", structure === s.id ? "text-accent" : "text-ink3")} aria-hidden="true" />
              <span>
                <span className="flex items-center gap-2 text-sm font-medium text-ink">{s.title}{s.id === "auto" && <span className="text-xs font-normal text-ink4">recommended</span>}</span>
                <span className="block text-xs text-ink3">{s.body}</span>
              </span>
            </button>
          ))}
        </div>
        {structure === "fleet-manual" && (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-ink3">The crew. {name || "This bot"} leads them; they get its permission level.</p>
            <CrewEditor value={crew} onChange={setCrew} max={maxCrew} />
          </div>
        )}
      </Section>

      <Section title="When it runs">
        <ScheduleEditor value={schedules} onChange={setSchedules} />
      </Section>

      <Section title="What it may do" hint={structure === "solo" ? undefined : "If it leads a fleet, its crew get the same level."}>
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
      {busy === "plan" && <p className="flex items-center gap-2 text-sm text-ink3"><Spinner size={13} /> Mercury is looking at the job (10–60 s)…</p>}
    </Frame>
  );
}

/** The scrolling form with its action bar always on screen. */
function Frame({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-8 py-8">{children}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-8 py-3">{footer}</div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
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
