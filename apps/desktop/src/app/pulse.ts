/* ═══════════════════════════════════════════════════════════════
   Pulse: the slow-moving runtime facts the chrome shows (owner, tokens,
   schedules, background work). One poller per connection, cadence per
   kind; live facts (agent state, bots) come from the event streams.
   ═══════════════════════════════════════════════════════════════ */

import { useEffect } from "react";
import type { TurnsInfo } from "~/api/types";
import { create } from "zustand";
import { http } from "~/api/client";

export interface UsageInfo {
  dailyUsed: number;
  dailyBudget: number;
  remaining: number;
  /** What counted toward the budget, by provider and by source (sums to dailyUsed on current runtimes). */
  byProvider: Record<string, number>;
  byChannel: Record<string, number>;
  requestLog: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; channelType: string; timestamp: number; cachedInputTokens?: number; noCacheInputTokens?: number; countedTokens?: number }>;
  /** Today's input/output split (runtimes from #296 on). */
  split?: import("~/views/settings/Budgets").DailySplit;
}

export interface ScheduleInfo {
  id: string;
  description: string;
  cron?: string;
  delaySeconds?: number;
  prompt?: string;
  botId?: string;
  nextRun?: string;
  executeAt?: string;
  timezone?: string;
  missedRunPolicy?: 'skip' | 'run_once';
  paused?: boolean;
  /** Older runtimes returned only a timestamp. */
  lastRun?: string | { id: string; status: 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped' | 'dispatched'; startedAt: string; finishedAt?: string; error?: string };
}

export interface BackgroundInfo {
  tasks: Array<{ id: string; description: string; status: string; createdAt: string }>;
  agents: Array<{ id: string; task: string; status: string; tokensUsed?: number }>;
}

interface PulseState {
  owner: string;
  agentName: string;
  usage: UsageInfo | null;
  schedules: ScheduleInfo[];
  background: BackgroundInfo;
  /** Chats working now and waiting for a slot; null on runtimes without it. */
  turns: TurnsInfo | null;
}

export const usePulse = create<PulseState>(() => ({
  owner: "",
  agentName: "",
  usage: null,
  schedules: [],
  background: { tasks: [], agents: [] },
  turns: null,
}));

async function loadIdentity() {
  try {
    const c = await http.get<{ identity?: { owner?: string; name?: string } }>("/api/config");
    usePulse.setState({ owner: c.identity?.owner ?? "", agentName: c.identity?.name ?? "" });
  } catch { /* older runtime */ }
}
async function loadUsage() {
  try { usePulse.setState({ usage: await http.get<UsageInfo>("/api/usage") }); } catch { /* keep */ }
}
async function loadSchedules() {
  try { usePulse.setState({ schedules: (await http.get<{ schedules: ScheduleInfo[] }>("/api/schedules")).schedules }); } catch { /* keep */ }
}
async function loadTurns() {
  try { usePulse.setState({ turns: await http.get<TurnsInfo>("/api/chat/running") }); } catch { usePulse.setState({ turns: null }); }
}
async function loadBackground() {
  const [tasks, agents] = await Promise.all([
    http.get<{ tasks: BackgroundInfo["tasks"] }>("/api/bg").then((r) => r.tasks).catch(() => []),
    http.get<{ agents: BackgroundInfo["agents"] }>("/api/agents").then((r) => r.agents).catch(() => []),
  ]);
  usePulse.setState({ background: { tasks, agents } });
}

export function usePulsePolling(connectionId: string): void {
  useEffect(() => {
    void loadIdentity();
    void loadUsage();
    void loadSchedules();
    void loadBackground();
    void loadTurns();
    const timers = [
      setInterval(() => void loadTurns(), 4_000),
      setInterval(() => void loadUsage(), 20_000),
      setInterval(() => void loadSchedules(), 60_000),
      setInterval(() => void loadBackground(), 8_000),
    ];
    const onFocus = () => { void loadUsage(); void loadBackground(); void loadTurns(); };
    window.addEventListener("focus", onFocus);
    return () => { timers.forEach(clearInterval); window.removeEventListener("focus", onFocus); };
  }, [connectionId]);
}

export const refreshPulse = { usage: loadUsage, schedules: loadSchedules, background: loadBackground, turns: loadTurns };

/** The thread ids that are working now / waiting for a slot. */
export function turnStates(turns: TurnsInfo | null): { running: Set<string>; queued: Set<string> } {
  const id = (t: { sessionId?: string; channelType: string; channelId: string }) => t.sessionId ?? (t.channelType === "web" ? t.channelId : undefined);
  return {
    running: new Set((turns?.running ?? []).map(id).filter((v): v is string => !!v)),
    queued: new Set((turns?.waiting ?? []).map(id).filter((v): v is string => !!v)),
  };
}
