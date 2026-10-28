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
/**
 * The version the listener reports, from whichever package.json sits above the running file.
 *
 * This counted `..` segments from `src/web/api/`, which is right for the sources and wrong for the
 * shipped bundle: packed, the code runs from `dist/mercury.js`, three levels up lands in
 * `node_modules/` where no package.json describes this agent, and `/api/health` answered
 * `version: ""` on every installed instance — the dashboard and the phone showed no version at all.
 * Walk up instead, and keep the first package.json that carries one.
 */
function versionString(): string {
  if (runtimeVersion) return runtimeVersion;
  const fromEnv = process.env.MERCURY_CHANNEL_VERSION;
  if (fromEnv) {
    runtimeVersion = fromEnv;
    return runtimeVersion;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (pkg?.version) {
        runtimeVersion = pkg.version;
        return runtimeVersion;
      }
    } catch { /* not here: keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  runtimeVersion = '';
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
