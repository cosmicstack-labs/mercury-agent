import { Crown, Plus } from "lucide-react";
import type { BotStatus } from "~/api/types";
import { BotAvatar } from "~/components/BotAvatar";
import { StateOrb } from "~/components/indicators/StateOrb";
import type { AgentState } from "~/app/store";
import { cx } from "~/lib/cx";

/**
 * Every bot at a glance, the way they're organised: fleets (a lead and its
 * crew) first, then the bots that work alone. One click opens a bot; the
 * last card makes a new one.
 */
export function BotsOverview({ fleets, solo, onOpen, onNew }: {
  fleets: Array<{ lead: BotStatus; crew: BotStatus[] }>;
  solo: BotStatus[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-7 px-8 py-7">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">All bots</h1>
        <p className="mt-0.5 text-sm text-ink3">
          {fleets.length} fleet{fleets.length === 1 ? "" : "s"} · {solo.length} on {solo.length === 1 ? "its" : "their"} own.
          A fleet is a lead that hands parts of a job to its crew; a bot on its own does the whole job.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Fleets</h2>
        {fleets.length === 0 && <p className="text-sm text-ink4">No fleets yet. Make one with New bot → “A fleet”, or turn a bot into a fleet lead from its page.</p>}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {fleets.map(({ lead, crew }) => {
            const working = crew.filter((c) => c.state === "running").length + (lead.state === "running" ? 1 : 0);
            return (
              <button key={lead.id} onClick={() => onOpen(lead.id)} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-line-strong">
                <div className="flex items-center gap-3">
                  <Avatar bot={lead} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-ink"><Crown size={13} className="shrink-0 text-amber" aria-hidden="true" /><span className="truncate">{lead.name}</span></div>
                    <div className="truncate text-xs text-ink3">{lead.description || "Fleet lead"}</div>
                  </div>
                  <Status bot={lead} />
                </div>
                <div className="flex items-center gap-2 border-t border-line pt-3">
                  <div className="flex -space-x-1.5">
                    {crew.slice(0, 8).map((c) => <span key={c.id} className="rounded-full ring-2 ring-surface"><BotAvatar id={c.id} name={c.name} hasAvatar={c.hasAvatar} size={24} dimmed={!c.enabled} /></span>)}
                  </div>
                  <span className="text-xs text-ink3">{crew.length} crew{working ? ` · ${working} working` : ""}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">On their own</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {solo.map((b) => (
            <button key={b.id} onClick={() => onOpen(b.id)} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left hover:border-line-strong">
              <Avatar bot={b} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{b.name}</div>
                <div className="truncate text-xs text-ink3">{b.description || "Works alone"}</div>
              </div>
              <Status bot={b} />
            </button>
          ))}
          <button onClick={onNew} className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line p-3.5 text-sm text-ink3 hover:border-line-strong hover:text-ink">
            <Plus size={15} /> New bot
          </button>
        </div>
      </section>
    </div>
  );
}

function Avatar({ bot, size }: { bot: BotStatus; size: number }) {
  return (
    <span className="relative shrink-0">
      <BotAvatar id={bot.id} name={bot.name} hasAvatar={bot.hasAvatar} size={size} dimmed={!bot.enabled || bot.stopped} />
      <StateOrb state={orb(bot)} size={9} className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface p-[1.5px]" />
    </span>
  );
}

function Status({ bot }: { bot: BotStatus }) {
  const label = !bot.enabled ? "Off" : bot.stopped ? "Stopped" : bot.needsYou ? "Needs you" : bot.state === "running" ? "Working" : bot.state === "queued" ? "Queued" : bot.state === "paused" ? "Paused" : "Idle";
  return (
    <span className="flex shrink-0 items-center gap-2">
      {!!bot.unread && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold leading-5 text-on-accent">{bot.unread}</span>}
      <span className={cx("text-xs", bot.needsYou ? "text-amber" : bot.state === "running" ? "text-accent" : "text-ink4")}>{label}</span>
    </span>
  );
}

function orb(b: BotStatus): AgentState {
  if (b.needsYou) return "needs-you";
  if (!b.enabled || b.state === "disabled") return "offline";
  if (b.state === "running") return "working";
  if (b.state === "queued") return "thinking";
  return "idle";
}
