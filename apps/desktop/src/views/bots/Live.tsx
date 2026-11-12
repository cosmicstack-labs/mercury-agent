import { ArrowUp, Check, ChevronRight, CircleAlert, CornerUpLeft, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "~/api/mercury";
import type { BotStatus } from "~/api/types";
import { refreshApprovals } from "~/app/events";
import { useBots } from "~/app/store";
import { BotAvatar } from "~/components/BotAvatar";
import { Button } from "~/components/ui/Button";
import { Badge, Empty } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { NeedsYou } from "~/components/needs-you/NeedsYou";
import { botQuestionItems } from "./Approvals";
import { runsFrom, startedBy, STATE_LABEL, type LiveRun } from "./live-runs";

/* ═══════════════════════════════════════════════════════════════
   Live: what a bot (or a whole fleet) is doing right now, as it
   happens, and a box to talk to it.

   One card per run: who started it and what was asked, each step as it
   runs (folded past the last few), what the bot is writing, how it
   ended. A question the bot asks you sits inside its run, with its
   buttons. The box at the bottom messages the bot (or a crew member);
   a message to a busy bot shows as queued at once. Reply on a finished
   run answers it with that run quoted.

   Costs little: the recent past loads once (GET /api/bots/activity),
   then the bots stream adds to it; the app keeps a capped log.
   ═══════════════════════════════════════════════════════════════ */

const SHOWN_STEPS = 6;
const SHOWN_RUNS = 40;

export function Live({ bots, defaultTarget }: { bots: BotStatus[]; defaultTarget: string }) {
  const ids = useMemo(() => bots.map((b) => b.id), [bots]);
  const idKey = ids.join(",");
  const live = useBots((s) => s.live);
  const approvals = useBots((s) => s.approvals);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState(defaultTarget);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => { setTarget(defaultTarget); }, [defaultTarget]);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void api.bots.activity(ids).then((r) => { if (alive) useBots.getState().addLive(r.events); }).catch(() => {}).finally(() => { if (alive) setLoaded(true); });
    void refreshApprovals();
    return () => { alive = false; };
  }, [idKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A clock for "ended" and elapsed times; cheap, and only while open.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const mine = useMemo(() => new Set(ids), [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = useMemo(() => new Set(bots.filter((b) => b.state === "running").map((b) => b.id)), [bots]);
  const myApprovals = useMemo(() => approvals.filter((a) => mine.has(a.botId)), [approvals, mine]);
  const runs = useMemo(
    () => runsFrom(live.filter((e) => mine.has(e.botId)), { running, approvals: myApprovals, now }),
    [live, mine, running, myApprovals, now],
  );
  const shown = older ? runs : runs.slice(-SHOWN_RUNS);
  const nameOf = (id: string) => bots.find((b) => b.id === id)?.name;
  const questions = useMemo(() => botQuestionItems(myApprovals, now), [myApprovals, now]);

  // Follow new activity while you're at the bottom; leave you alone when you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [runs]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setProblem(null);
    try {
      const r = await api.bots.message(target, text);
      if (!r.accepted) setProblem(r.reasonCode === "target_disabled" ? "That bot is off. Turn it on to message it." : `Not sent (${r.reasonCode ?? "refused"}).`);
      else { setDraft(""); pinned.current = true; }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function reply(run: LiveRun) {
    setTarget(run.botId);
    const said = (run.text ?? run.endLabel ?? "").replace(/\s+/g, " ").trim().slice(-160);
    setDraft(`Re your run "${(run.prompt ?? "").slice(0, 60)}"${said ? ` (you said: "…${said}")` : ""}:\n`);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(box.current.value.length, box.current.value.length); });
  }

  return (
    <div className="flex h-[calc(100vh-260px)] min-h-[420px] flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!older && runs.length > SHOWN_RUNS && (
          <button onClick={() => setOlder(true)} className="mx-auto mb-3 block text-xs text-ink3 hover:text-ink">Show {runs.length - SHOWN_RUNS} earlier runs</button>
        )}
        {loaded && runs.length === 0 && questions.length === 0 && (
          <Empty title="Nothing happening yet" body="When a bot starts a run (on its schedule, from another bot, or from your message below), you'll see each step here as it happens." />
        )}
        <div className="flex flex-col gap-3">
          {shown.map((r) => (
            <RunCard key={r.jobId} run={r} bot={bots.find((b) => b.id === r.botId)} fleet={bots.length > 1} by={startedBy(r, nameOf)}
              waiting={myApprovals.some((a) => a.runId === r.jobId)} onReply={() => reply(r)} now={now} />
          ))}
        </div>
      </div>

      {questions.length > 0 && <div className="border-t border-line bg-soft/60 px-3 pt-3"><NeedsYou items={questions} /></div>}
      <div className="border-t border-line bg-soft/60 p-3">
        {problem && <p className="mb-2 text-xs text-red">{problem}</p>}
        <div className="flex items-end gap-2">
          {bots.length > 1 && (
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Send to"
              className="h-9 max-w-[180px] shrink-0 rounded-lg border border-line bg-surface px-2 text-sm text-ink">
              {bots.map((b) => <option key={b.id} value={b.id}>{b.name}{b.id === defaultTarget ? " (lead)" : ""}</option>)}
            </select>
          )}
          <textarea ref={box} value={draft} rows={1} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder={`Message ${nameOf(target) ?? "the bot"}… (runs now, or after its current run)`}
            className="max-h-40 min-h-[36px] flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent/60" />
          <Button variant="primary" size="sm" icon onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

const TONE: Record<LiveRun["state"], "accent" | "amber" | "red" | "neutral"> = {
  queued: "neutral", working: "accent", waiting: "amber", done: "neutral", failed: "red", stopped: "neutral", paused: "amber", ended: "neutral",
};

function RunCard({ run, bot, fleet, by, waiting, onReply, now }: {
  run: LiveRun; bot?: BotStatus; fleet: boolean; by: string; waiting: boolean; onReply: () => void; now: number;
}) {
  const [allSteps, setAllSteps] = useState(false);
  const active = run.state === "working" || run.state === "waiting" || run.state === "queued";
  const hidden = allSteps ? 0 : Math.max(0, run.steps.length - SHOWN_STEPS);
  const steps = run.steps.slice(hidden);
  const fromYou = by.startsWith("You");
  const elapsed = Math.max(0, (active ? now : run.updatedAt) - run.startedAt);
  return (
    <div className="flex flex-col gap-2">
      {run.prompt && fromYou && (
        <div className="ml-auto max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-ink" data-selectable>
          {run.prompt}
          {fleet && <span className="mt-1 block text-2xs text-ink4">to {run.botName}</span>}
        </div>
      )}
      <div className={cx("rounded-xl border bg-surface px-4 py-3", run.state === "waiting" ? "border-amber/50" : run.state === "failed" ? "border-red/30" : active ? "border-accent/35" : "border-line")}>
        <div className="flex items-center gap-2.5">
          <BotAvatar id={run.botId} name={run.botName} hasAvatar={bot?.hasAvatar} size={24} />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium text-ink">{run.botName}</span>
            {!fromYou && <span className="text-ink3"> · {by}</span>}
          </span>
          <span className="shrink-0 font-mono text-2xs text-ink4">{fmtTime(run.startedAt)} · {fmtDur(elapsed)}{run.stepCount ? ` · ${run.stepCount} step${run.stepCount === 1 ? "" : "s"}` : ""}</span>
          <Badge tone={TONE[run.state]}>{active && run.state !== "waiting" && <Loader2 size={10} className="mr-1 inline animate-spin" />}{STATE_LABEL[run.state]}</Badge>
        </div>

        {run.prompt && !fromYou && <p className="mt-2 line-clamp-3 text-sm text-ink2" data-selectable>{run.prompt}</p>}

        {(steps.length > 0 || hidden > 0) && (
          <ol className="mt-2.5 flex flex-col gap-1 border-l border-line pl-3">
            {hidden > 0 && (
              <li><button onClick={() => setAllSteps(true)} className="flex items-center gap-1 text-xs text-ink3 hover:text-ink"><ChevronRight size={12} /> {hidden} earlier step{hidden === 1 ? "" : "s"}</button></li>
            )}
            {steps.map((s, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2 text-xs">
                <span className="mt-[1px] shrink-0">
                  {s.status === "running" ? <Loader2 size={12} className="animate-spin text-accent" />
                    : s.status === "error" ? <CircleAlert size={12} className="text-red" />
                    : s.status === "note" ? <MessageSquare size={12} className="text-ink4" />
                    : <Check size={12} className="text-accent" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx("break-all font-mono", s.status === "note" ? "text-ink3" : "text-ink2")}>{s.label}</span>
                  {s.detail && s.status === "error" && <span className="block break-all text-red/90">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}

        {run.text && (
          <p className={cx("mt-2.5 line-clamp-4 whitespace-pre-wrap text-sm", active ? "text-ink3" : "text-ink2")} data-selectable>{run.text.trim()}</p>
        )}

        {waiting && <p className="mt-2.5 text-xs text-amber">Waiting for your answer: see Needs you below.</p>}

        {!active && (
          <div className="mt-2.5 flex items-center gap-3 text-xs text-ink4">
            {run.endLabel && run.state !== "done" && <span className="truncate">{run.endLabel}</span>}
            {run.state === "ended" && <span>No ending was reported (Mercury restarted during the run).</span>}
            <span className="flex-1" />
            <button onClick={onReply} className="flex items-center gap-1 text-ink3 hover:text-ink"><CornerUpLeft size={12} /> Reply</button>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
