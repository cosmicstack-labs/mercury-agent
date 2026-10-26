import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackRequest } from '../middleware.js';
import { peekPluginManager } from '../../plugins/manager.js';
import { getLoopLag } from '../../utils/loop-lag.js';

export interface AgentStatus {
  running: boolean;
  pid: number | null;
  state: string;
  uptime: string;
  defaultProvider: string;
  providers: Array<{ name: string; enabled: boolean; hasKey: boolean }>;
  tokensUsed: number;
  tokenBudget: number;
  memoryTotal: number;
  memoryByType: Record<string, number>;
}

let currentStatus: AgentStatus = {
  running: false,
  pid: null,
  state: 'unknown',
  uptime: '—',
  defaultProvider: '—',
  providers: [],
  tokensUsed: 0,
  tokenBudget: 1000000,
  memoryTotal: 0,
  memoryByType: {},
};

export function updateStatus(status: Partial<AgentStatus>): void {
  currentStatus = { ...currentStatus, ...status };
}

export function getStatus(): AgentStatus {
  return { ...currentStatus };
}

const status = new Hono();

let runtimeVersion = '';
function versionString(): string {
  if (runtimeVersion) return runtimeVersion;
  try {
    runtimeVersion = process.env.MERCURY_CHANNEL_VERSION
      || JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8')).version
      || '';
  } catch { runtimeVersion = ''; }
  return runtimeVersion;
}

/**
 * Liveness for `mercury attach` — no auth, loopback only, answers the
 * moment the listener is bound (before channels and bots have booted). The
 * pid lets a launcher tell "my runtime, still booting" from "some other
 * process owns this port" without a restart.
 */
status.get('/api/health', (c) => {
  if (!isLoopbackRequest(c)) return c.json({ error: 'Not found' }, 404);
  const lag = getLoopLag();
  const plugins = peekPluginManager()?.health();
  return c.json({ ok: true, pid: process.pid, version: versionString(), state: currentStatus.state, booting: currentStatus.state === 'booting', loopLag: { p99Ms: Math.round(lag.p99Ms), maxMs: Math.round(lag.maxMs) }, ...(plugins ? { plugins: { safeMode: plugins.safeMode, running: plugins.running, tools: plugins.tools } } : {}) });
});

status.get('/api/status', (c) => {
  const s = getStatus();

  // Transform to the shape the React frontend expects
  const providersMap: Record<string, { enabled: boolean; hasKey: boolean }> = {};
  for (const p of s.providers) {
    providersMap[p.name] = { enabled: p.enabled, hasKey: p.hasKey };
  }

  return c.json({
    running: s.running,
    state: s.state,
    uptime: Math.floor(process.uptime()),
    providers: providersMap,
    tokens: {
      dailyUsed: s.tokensUsed,
      dailyBudget: s.tokenBudget,
    },
    memory: {
      total: s.memoryTotal,
      byType: s.memoryByType,
    },
  });
});

export default status;
