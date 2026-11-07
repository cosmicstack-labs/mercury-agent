/* ═══════════════════════════════════════════════════════════════
   Pulse: the slow-moving runtime facts the chrome shows (owner, tokens,
   schedules, background work). One poller per connection, cadence per
   kind; live facts (agent state, bots) come from the event streams.
   ═══════════════════════════════════════════════════════════════ */

import { useEffect } from "react";
import { create } from "zustand";
import { http } from "~/api/client";

export interface UsageInfo {
  dailyUsed: number;
  dailyBudget: number;
  remaining: number;
  byProvider: Record<string, number>;
  byChannel: Record<string, number>;
  requestLog: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; channelType: string; timestamp: number }>;
}

export interface ScheduleInfo {
  id: string;
  description: string;
  cron?: string;
  delaySeconds?: number;
  prompt?: string;
  botId?: string;
  nextRun?: string;
  lastRun?: string;
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
}

export const usePulse = create<PulseState>(() => ({
  owner: "",
  agentName: "",
  usage: null,
  schedules: [],
  background: { tasks: [], agents: [] },
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
    const timers = [
      setInterval(() => void loadUsage(), 20_000),
      setInterval(() => void loadSchedules(), 60_000),
      setInterval(() => void loadBackground(), 8_000),
    ];
    const onFocus = () => { void loadUsage(); void loadBackground(); };
    window.addEventListener("focus", onFocus);
    return () => { timers.forEach(clearInterval); window.removeEventListener("focus", onFocus); };
  }, [connectionId]);
}

export const refreshPulse = { usage: loadUsage, schedules: loadSchedules, background: loadBackground };
