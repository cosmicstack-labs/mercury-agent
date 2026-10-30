import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { Bot, CalendarClock, Code2, Coins, Cpu, Layers, Server, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { cx } from "~/lib/cx";
import * as api from "~/api/mercury";
import type { ChatSettings, CodeStatus } from "~/api/types";
import { useBots, useRuntimeState, useUi } from "~/app/store";
import { refreshPulse, usePulse, type ScheduleInfo } from "~/app/pulse";
import { http } from "~/api/client";
import { useConnections } from "~/shell/connections";
import { StateOrb, LABELS } from "~/components/indicators/StateOrb";
import { StatusButton, StatusPopover } from "~/layout/StatusBar";
import { compact } from "~/views/bots/Usage";
import { mercuryUi } from "./registry";
import { useVoice, phaseOf, PHASE_LABEL } from "~/app/voice";
import { OptimusFace } from "~/components/OptimusFace";

/* The built-in status bar items. Each is a contribution like any plugin's. */

const Trigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & { tone?: "accent" | "amber" | "red" | "cyan" }>(function Trigger({ className, tone, ...rest }, ref) {
  return (
    <button
      ref={ref}
      {...rest}
      className={cx("flex h-[22px] items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-ink/[0.07] hover:text-ink data-[state=open]:bg-ink/[0.07]",
        tone === "accent" && "text-accent", tone === "amber" && "text-amber", tone === "red" && "text-red", tone === "cyan" && "text-cyan", className)}
    />
  );
});

function Connection() {
  const connected = useRuntimeState((s) => s.connected);
  const active = useConnections((s) => s.connections.find((c) => c.id === s.activeId));
  const setView = useUi((s) => s.setView);
  return (
    <StatusButton title={active ? `${active.name} · ${active.baseUrl}` : "No connection"} onClick={() => setView("settings")} tone={connected ? undefined : "red"}>
      <Server size={13} />
      <span className="max-w-[160px] truncate">{active?.name ?? "—"}</span>
      {!connected && <span>offline</span>}
    </StatusButton>
  );
}

function AgentState() {
  const agent = useRuntimeState((s) => s.agent);
  const step = useRuntimeState((s) => s.step);
  const prompts = useRuntimeState((s) => s.prompts.length);
  const setView = useUi((s) => s.setView);
  return (
    <StatusButton title="What Mercury is doing" onClick={() => setView("chat")} tone={agent === "needs-you" ? "amber" : undefined}>
      <StateOrb state={agent} size={9} />
      <span>{LABELS[agent]}</span>
      {step?.tool && (agent === "working" || agent === "thinking") && <span className="max-w-[160px] truncate font-mono text-ink4">{step.tool}{step.total ? ` ${step.current}/${step.total}` : ""}</span>}
      {prompts > 0 && <span className="text-amber">· {prompts} waiting</span>}
    </StatusButton>
  );
}

function Background() {
  const bg = usePulse((s) => s.background);
  const runningTasks = bg.tasks.filter((t) => /run|pend|queue/i.test(t.status));
  const agents = bg.agents.filter((a) => !/done|complete|fail|cancel/i.test(a.status));
  const count = runningTasks.length + agents.length;
  return (
    <StatusPopover width={360} trigger={
      <Trigger title="Background work" tone={count ? "accent" : undefined}>
        <Layers size={13} />
        <span>{count ? `${count} running` : "Idle"}</span>
      </Trigger>
    }>
      <PanelTitle>Background</PanelTitle>
      {count === 0 && <p className="text-sm text-ink3">Nothing running in the background.</p>}
      {agents.map((a) => <Line key={a.id} icon={<Cpu size={13} />} title={a.task} detail={`sub-agent · ${a.status}${a.tokensUsed ? ` · ${compact(a.tokensUsed)} tok` : ""}`} />)}
      {runningTasks.map((t) => <Line key={t.id} icon={<Layers size={13} />} title={t.description} detail={t.status} />)}
    </StatusPopover>
  );
}

/** Bots at work: the rail's bot icon and how many are running. Hidden when none are. */
function BotsRunning() {
  const bots = useBots((s) => s.bots);
  const activity = useBots((s) => s.activity);
  const setView = useUi((s) => s.setView);
  const running = bots.filter((b) => b.state === "running" || b.state === "queued" || activity[b.id]);
  if (running.length === 0) return null;
  return (
    <StatusPopover width={340} trigger={
      <Trigger title={`${running.length} bot${running.length === 1 ? "" : "s"} running`} tone="accent">
        <Bot size={14} />
        <span>{running.length}</span>
      </Trigger>
    }>
      <PanelTitle>Bots running · {running.length}</PanelTitle>
      {running.map((b) => <Line key={b.id} icon={<Bot size={13} />} title={b.name} detail={activity[b.id] ?? (b.state === "queued" ? "queued" : "working")} />)}
      <button onClick={() => setView("bots")} className="mt-1 w-full rounded-md px-1 py-1.5 text-left text-xs text-accent hover:underline">Open Bots</button>
    </StatusPopover>
  );
}

/** Optimus voice: its face and phase while a session runs; click to open it. */
function OptimusVoice() {
  const v = useVoice();
  const setView = useUi((s) => s.setView);
  const setVoiceOpen = useUi((s) => s.setVoiceOpen);
  if (!v.active) return null;
  const phase = phaseOf(v);
  return (
    <StatusButton title="Optimus voice session" tone="accent" onClick={() => { setVoiceOpen(true); setView("chat"); }}>
      <OptimusFace size={15} phase={phase} />
      <span>{PHASE_LABEL[phase]}</span>
    </StatusButton>
  );
}

function Schedules() {
  const schedules = usePulse((s) => s.schedules);
  return (
    <StatusPopover width={380} trigger={
      <Trigger title="Schedules">
        <CalendarClock size={13} />
        <span>{schedules.length} scheduled</span>
      </Trigger>
    }>
      <PanelTitle>Schedules · {schedules.length}</PanelTitle>
      {schedules.length === 0 && <p className="text-sm text-ink3">Nothing scheduled.</p>}
      {schedules.map((s) => <ScheduleRow key={s.id} s={s} />)}
    </StatusPopover>
  );
}

/** One schedule, with delete: click the bin, then "Delete?" within a few seconds to confirm. */
function ScheduleRow({ s }: { s: ScheduleInfo }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await http.delete(`/api/schedules/${encodeURIComponent(s.id)}`);
      await refreshPulse.schedules();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setArmed(false);
    }
  }
  const detail = [s.cron ? cronLabel(s.cron) : s.delaySeconds ? `in ${s.delaySeconds}s` : "", s.botId ? `bot ${s.botId}` : "", s.nextRun ? `next ${new Date(s.nextRun).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}` : ""].filter(Boolean).join(" · ");
  return (
    <div className={cx("group flex items-start gap-2 rounded-md px-1 py-1.5", busy && "opacity-50")}>
      <span className="mt-0.5 text-ink3"><CalendarClock size={13} /></span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm text-ink">{s.description || s.id}</span>
        {detail && <span className="block truncate text-xs text-ink4">{detail}</span>}
        {error && <span className="block text-xs text-red">{error}</span>}
      </span>
      {armed ? (
        <button onClick={() => void remove()} disabled={busy} className="shrink-0 rounded-md bg-red/10 px-2 py-0.5 text-xs font-medium text-red hover:bg-red/15" aria-label={`Confirm deleting ${s.description || s.id}`}>
          {busy ? "Deleting…" : "Delete?"}
        </button>
      ) : (
        <button onClick={() => setArmed(true)} className="shrink-0 rounded-md p-1 text-ink4 opacity-0 transition-opacity hover:bg-ink/[0.06] hover:text-red focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Delete ${s.description || s.id}`} title="Delete">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function Tokens() {
  const usage = usePulse((s) => s.usage);
  if (!usage) return null;
  const ratio = usage.dailyBudget ? usage.dailyUsed / usage.dailyBudget : 0;
  const providers = Object.entries(usage.byProvider).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const channels = Object.entries(usage.byChannel).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const models = new Map<string, { tokens: number; requests: number }>();
  let input = 0, output = 0;
  for (const r of usage.requestLog) {
    const m = models.get(r.model) ?? { tokens: 0, requests: 0 };
    m.tokens += r.totalTokens; m.requests += 1;
    models.set(r.model, m);
    input += r.inputTokens; output += r.outputTokens;
  }
  return (
    <StatusPopover width={380} trigger={
      <Trigger title="Tokens used today" tone={ratio > 0.9 ? "red" : ratio > 0.7 ? "amber" : undefined}>
        <Coins size={13} />
        <span>{compact(usage.dailyUsed)}</span>
        <span className="h-1 w-10 overflow-hidden rounded-full bg-ink/[0.12]"><span className={cx("block h-full rounded-full", ratio > 0.9 ? "bg-red" : ratio > 0.7 ? "bg-amber" : "bg-accent")} style={{ width: `${Math.max(3, Math.min(100, ratio * 100))}%` }} /></span>
      </Trigger>
    }>
      <PanelTitle>Tokens today</PanelTitle>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-2xl font-semibold tracking-tight">{compact(usage.dailyUsed)}</span>
        <span className="font-mono text-xs text-ink3">of {compact(usage.dailyBudget)} · {compact(usage.remaining)} left</span>
      </div>
      <Breakdown title="By source" rows={channels} total={usage.dailyUsed} />
      <Breakdown title="By provider" rows={providers} total={usage.dailyUsed} />
      {models.size > 0 && (
        <>
          <Breakdown title={`By model · last ${usage.requestLog.length} requests`} rows={[...models.entries()].map(([k, v]) => [k, v.tokens] as [string, number]).sort((a, b) => b[1] - a[1])} total={[...models.values()].reduce((n, m) => n + m.tokens, 0)} />
          <p className="mt-1 text-xs text-ink4">Those requests: {compact(input)} in · {compact(output)} out</p>
        </>
      )}
    </StatusPopover>
  );
}

function Model() {
  const provider = useRuntimeState((s) => s.provider);
  const model = useRuntimeState((s) => s.model);
  if (!model && !provider) return null;
  return (
    <StatusButton title={`${provider} · ${model}`}>
      <Cpu size={13} />
      <span className="max-w-[200px] truncate">{model || provider}</span>
    </StatusButton>
  );
}

function Approval() {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const view = useUi((s) => s.view);
  useEffect(() => { void api.chat.settings().then(setSettings).catch(() => {}); }, [view]);
  if (!settings) return null;
  const allowAll = settings.bypassPermissions;
  return (
    <StatusButton title="Click to switch Ask Me / Allow All" tone={allowAll ? "accent" : "amber"}
      onClick={() => void api.chat.updateSettings({ bypassPermissions: !allowAll }).then(setSettings).catch(() => {})}>
      {allowAll ? <ShieldCheck size={13} /> : <Shield size={13} />}
      <span>{allowAll ? "Allow All" : "Ask Me"}</span>
    </StatusButton>
  );
}

function CodeMode() {
  const [status, setStatus] = useState<CodeStatus | null>(null);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  useEffect(() => { void api.code.status().then(setStatus).catch(() => {}); }, [view]);
  if (!status?.available) return null;
  return (
    <StatusButton title="Code mode" onClick={() => setView("code")} tone={status.state !== "off" ? "cyan" : undefined}>
      <Code2 size={13} />
      <span className="capitalize">{status.state === "off" ? "Code off" : `Code ${status.state}`}</span>
    </StatusButton>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-ink4">{children}</div>;
}

function Line({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-1 py-1.5">
      <span className="mt-0.5 text-ink3">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm text-ink">{title}</span>
        {detail && <span className="block truncate text-xs text-ink4">{detail}</span>}
      </span>
    </div>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: Array<[string, number]>; total: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-xs text-ink3">{title}</div>
      {rows.slice(0, 6).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[1fr_90px_52px] items-center gap-2 py-0.5 text-xs">
          <span className="truncate text-ink">{k}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]"><span className="block h-full rounded-full bg-accent" style={{ width: `${total ? (v / total) * 100 : 0}%` }} /></span>
          <span className="text-right font-mono text-ink3">{compact(v)}</span>
        </div>
      ))}
    </div>
  );
}

function cronLabel(cron: string): string {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (m) return `every ${m[1]} min`;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(cron.trim());
  if (h) return `every ${h[1]} h`;
  return cron;
}

let registered = false;

/** Register the built-ins once; plugins call mercuryUi.registerStatusItem the same way. */
export function registerBuiltinStatusItems(): void {
  if (registered) return;
  registered = true;
  mercuryUi.registerStatusItem({ id: "mercury.connection", title: "Connection", area: "status.left", priority: 100, render: Connection });
  mercuryUi.registerStatusItem({ id: "mercury.agent", title: "Agent state", area: "status.left", priority: 90, render: AgentState });
  mercuryUi.registerStatusItem({ id: "mercury.optimus", title: "Optimus voice", area: "status.left", priority: 88, render: OptimusVoice });
  mercuryUi.registerStatusItem({ id: "mercury.bots", title: "Bots running", area: "status.left", priority: 85, render: BotsRunning });
  mercuryUi.registerStatusItem({ id: "mercury.background", title: "Background work", area: "status.left", priority: 80, render: Background });
  mercuryUi.registerStatusItem({ id: "mercury.schedules", title: "Schedules", area: "status.left", priority: 70, render: Schedules });
  mercuryUi.registerStatusItem({ id: "mercury.code", title: "Code mode", area: "status.right", priority: 70, views: ["chat", "code"], render: CodeMode });
  mercuryUi.registerStatusItem({ id: "mercury.approval", title: "Ask Me / Allow All", area: "status.right", priority: 60, views: ["chat", "code"], render: Approval });
  mercuryUi.registerStatusItem({ id: "mercury.model", title: "Model", area: "status.right", priority: 50, views: ["chat", "code"], render: Model });
  mercuryUi.registerStatusItem({ id: "mercury.tokens", title: "Tokens today", area: "status.right", priority: 40, render: Tokens });
}
