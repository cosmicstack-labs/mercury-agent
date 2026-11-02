import { AlertTriangle, CheckCheck, CircleCheck, FileText, Inbox as InboxIcon, OctagonAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { BotInboxEntry, BotStatus } from "~/api/types";
import { useBots } from "~/app/store";
import { refreshBots } from "~/app/events";
import { BotAvatar } from "~/components/BotAvatar";
import { Markdown } from "~/components/Markdown";
import { Button } from "~/components/ui/Button";
import { Badge, Empty, Spinner } from "~/components/ui/bits";
import { Dialog } from "~/components/ui/Dialog";
import { cx } from "~/lib/cx";
import { Preview } from "./Deliverables";

/**
 * The inbox: what the bots did for you, newest first, kept until you read it
 * — results (the bot's own summary, and the files it delivered), failures a
 * bot reported, and runs that need you. Runs where nothing was new aren't
 * here; the bot's Activity has every run.
 */
export function BotInbox({ bots, botId, onOpenBot }: { bots: BotStatus[]; botId?: string; onOpenBot?: (id: string) => void }) {
  const version = useBots((s) => s.inboxVersion);
  const [entries, setEntries] = useState<BotInboxEntry[] | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [file, setFile] = useState<{ botId: string; path: string } | null>(null);
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);

  async function load() {
    try {
      const r = await api.bots.inbox({ bot: botId, unread: filter === "unread", limit: 200 });
      setEntries(r.entries);
    } catch {
      setEntries([]);
    }
  }
  useEffect(() => { void load(); }, [botId, filter, version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function markRead(ids?: string[]) {
    const r = await api.bots.markRead(ids).catch(() => null);
    setEntries((list) => list?.map((e) => (!ids || ids.includes(e.id) ? { ...e, read: true } : e)) ?? null);
    if (r) useBots.getState().inboxChanged(r.unread);
    void refreshBots();
  }

  if (entries === null) return <div className="flex h-40 items-center justify-center text-ink3"><Spinner size={18} /></div>;
  const unread = entries.filter((e) => !e.read).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-ink/[0.05] p-0.5">
          {(["all", "unread"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cx("rounded-md px-2.5 py-1 text-xs", filter === f ? "bg-surface text-ink shadow-sm" : "text-ink3 hover:text-ink")}>
              {f === "all" ? "All" : "Unread"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {unread > 0 && <Button size="sm" variant="ghost" onClick={() => void markRead(entries.filter((e) => !e.read).map((e) => e.id))}><CheckCheck size={13} /> Mark all read</Button>}
      </div>

      {entries.length === 0 && (
        <Empty
          title={filter === "unread" ? "Nothing unread" : "Nothing here yet"}
          body={botId ? "When this bot finishes something, reports a problem, or needs you, it lands here." : "When a bot finishes something, reports a problem, or needs you, it lands here — even if the app was closed. Runs with nothing new stay quiet."}
        />
      )}

      {groupByDay(entries).map(([day, list]) => (
        <div key={day} className="flex flex-col gap-2">
          <div className="text-2xs font-medium uppercase tracking-wider text-ink4">{day}</div>
          {list.map((e) => {
            const bot = byId.get(e.botId);
            return (
              <article key={e.id} onClick={() => { if (!e.read) void markRead([e.id]); }}
                className={cx("flex gap-3 rounded-xl border bg-surface p-4", e.read ? "border-line" : "border-accent/40")}>
                <BotAvatar id={e.botId} name={e.botName} hasAvatar={bot?.hasAvatar} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <KindIcon kind={e.kind} />
                    <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug text-ink">{e.title}</h3>
                    {!e.read && <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="unread" />}
                    <time className="shrink-0 text-xs text-ink4">{time(e.at)}</time>
                  </div>
                  <div className="mt-1.5 max-h-[220px] overflow-y-auto text-sm text-ink2">
                    <Markdown text={e.summary} />
                  </div>
                  {(e.files.length > 0 || e.complete || e.kind === "needs-you") && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {e.files.map((f) => (
                        <button key={f} onClick={() => setFile({ botId: e.botId, path: f })} className="flex max-w-[280px] items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:border-line-strong hover:text-ink">
                          <FileText size={12} className="shrink-0" /> <span className="truncate">{basename(f)}</span>
                        </button>
                      ))}
                      {e.complete && <Badge tone="accent">job done</Badge>}
                      {e.kind === "needs-you" && e.reasonCode && <Badge tone="amber">{e.reasonCode.replace(/_/g, " ")}</Badge>}
                    </div>
                  )}
                  {!botId && onOpenBot && (
                    <button onClick={() => onOpenBot(e.botId)} className="mt-2 text-xs text-ink3 hover:text-ink">Open {e.botName} →</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ))}

      <Dialog open={!!file} onOpenChange={(o) => { if (!o) setFile(null); }} title={file ? basename(file.path) : ""} width={820}>
        {file && <Preview d={{ botId: file.botId, name: basename(file.path), bytes: 0, mtimeMs: Date.now() }} onDeleted={() => setFile(null)} />}
      </Dialog>
    </div>
  );
}

function KindIcon({ kind }: { kind: BotInboxEntry["kind"] }) {
  if (kind === "result") return <CircleCheck size={15} className="mt-0.5 shrink-0 text-ok" aria-label="result" />;
  if (kind === "failed") return <OctagonAlert size={15} className="mt-0.5 shrink-0 text-red" aria-label="couldn't do it" />;
  return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber" aria-label="needs you" />;
}

/** The inbox entry in the sidebar: an icon, "Inbox", and the unread count. */
export function InboxRow({ active, unread, waiting = 0, onClick }: { active: boolean; unread: number; waiting?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("mb-2 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", active ? "bg-ink/[0.07]" : "hover:bg-ink/[0.05]")}>
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink/[0.06]"><InboxIcon size={15} className="text-ink2" /></span>
      <span className="flex-1 text-sm font-medium text-ink">Inbox</span>
      {waiting > 0 && <span className="rounded-full bg-amber px-1.5 text-2xs font-semibold leading-5 text-black" aria-label={`${waiting} waiting for your answer`}>{waiting} asking</span>}
      {unread > 0 && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold leading-5 text-on-accent">{unread}</span>}
    </button>
  );
}

function groupByDay(entries: BotInboxEntry[]): Array<[string, BotInboxEntry[]]> {
  const out = new Map<string, BotInboxEntry[]>();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  for (const e of entries) {
    const d = new Date(e.at).toDateString();
    const label = d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(e.at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    out.set(label, [...(out.get(label) ?? []), e]);
  }
  return [...out];
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
