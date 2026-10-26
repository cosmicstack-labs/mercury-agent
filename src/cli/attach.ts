import { getForegroundRuntimeStatus, getDaemonStatus } from './daemon.js';
import { serviceDrift } from './service.js';
import { getWebPort, readAttachToken } from '../web/auth.js';

/**
 * Attach client transport. A second terminal connects to an already-running
 * Mercury runtime over its local web server: REST for actions (send,
 * permissions, sessions) and an SSE feed for live agent events. Auth is the
 * machine-local attach token written by the runtime at boot (0600 file) —
 * see writeAttachToken/readAttachToken in web/auth.ts.
 *
 * v1 scope: the attached client sees its own requests' activity live
 * (responses stream back to the originating channel) plus shared session
 * history. Live cross-surface mirroring of the owning terminal is out of
 * scope.
 */

export type AttachEventType =
  | 'connected'
  | 'status'
  | 'thinking'
  | 'provider'
  | 'heartbeat'
  | 'step_start'
  | 'step_done'
  | 'text_delta'
  | 'text_done'
  | 'permission_request'
  | 'permission_continue'
  | 'permission_mode'
  | 'permission_resolved'
  | 'choice_prompt'
  | 'choice_resolved'
  | 'loop_warning'
  | 'error'
  | 'session_switched'
  // Client-transport pseudo-events (never sent by the server).
  | 'attach_disconnected'
  | 'attach_auth_error';

export interface AttachEvent {
  type: AttachEventType;
  data: Record<string, unknown>;
}

export interface AttachThread {
  id: string;
  shortId: string;
  alias: string;
  title: string;
  updatedAt: string;
}

export interface AttachThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind?: string;
  content: string;
  timestamp: string;
}

/** Incremental text/event-stream frame parser (SSE). */
export interface SseParser {
  push(chunk: string): Array<{ event: string; data: string }>;
}

/**
 * Parse an SSE byte stream into frames. Handles `event:`/`data:` lines,
 * comment lines (`: keepalive`), and both \n and \r\n line endings. Incomplete
 * trailing lines are held back until the next push completes them.
 */
export function createSseParser(): SseParser {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (frames: Array<{ event: string; data: string }>): void => {
    if (eventName || dataLines.length > 0) {
      frames.push({ event: eventName || 'message', data: dataLines.join('\n') });
      eventName = '';
      dataLines = [];
    }
  };

  return {
    push(chunk: string): Array<{ event: string; data: string }> {
      const frames: Array<{ event: string; data: string }> = [];
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) {
          flush(frames);
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keepalive
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      return frames;
    },
  };
}

export interface RuntimeHealth {
  pid: number | null;
  version: string;
  booting: boolean;
}

export class AttachClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    /** Pids a healthy answer may come from (foreground + daemon); any other pid means a foreign process owns the port. */
    private readonly expectedPids: number[] = [],
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
    });
  }

  /**
   * Is the runtime we expect answering on this port? Errors are typed by
   * message: 'booting' (ours, not ready — retry), 'auth' (token rotated),
   * 'foreign:<pid>:<version>' (another process owns the port — never
   * retry, never restart), anything else = not listening yet.
   */
  async healthCheck(timeoutMs = 2000): Promise<RuntimeHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.request('/api/health', { signal: controller.signal });
      if (res.status === 404) {
        // Runtime older than /api/health: fall back to the authenticated probe.
        const legacy = await this.request('/api/chat/models', { signal: controller.signal });
        if (legacy.status === 401) throw new Error('auth');
        if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
        return { pid: null, version: '', booting: false };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Partial<RuntimeHealth>;
      const health: RuntimeHealth = { pid: typeof body.pid === 'number' ? body.pid : null, version: String(body.version ?? ''), booting: body.booting === true };
      if (health.pid !== null && this.expectedPids.length > 0 && !this.expectedPids.includes(health.pid)) {
        throw new Error(`foreign:${health.pid}:${health.version}`);
      }
      if (health.booting) throw new Error('booting');
      // The listener is ours; make sure the token we read is the one it wrote.
      const authed = await this.request('/api/chat/models', { signal: controller.signal });
      if (authed.status === 401) throw new Error('auth');
      return health;
    } finally {
      clearTimeout(timer);
    }
  }

  getBaseUrl(): string { return this.baseUrl; }

  /** Provider the runtime answers with right now (launch pad "Provider" row). */
  async currentModel(): Promise<{ name: string; model: string } | null> {
    try {
      const res = await this.request('/api/chat/models');
      if (!res.ok) return null;
      const body = await res.json() as { current?: { name?: string; model?: string } };
      return body.current?.name ? { name: body.current.name, model: body.current.model ?? '' } : null;
    } catch { return null; }
  }

  /** Today's token use against the cap (launch pad "Budget" row). */
  async budget(): Promise<{ used: number; budget: number } | null> {
    try {
      const res = await this.request('/api/status');
      if (!res.ok) return null;
      // /api/status reports { tokens: { dailyUsed, dailyBudget } }; the old
      // field names never matched, so the launch pad budget row never showed.
      const b = await res.json() as Record<string, unknown> & { tokens?: { used?: number; budget?: number; dailyUsed?: number; dailyBudget?: number } };
      const used = Number(b.tokens?.dailyUsed ?? b.tokensUsed ?? b.tokens?.used ?? NaN);
      const budget = Number(b.tokens?.dailyBudget ?? b.tokenBudget ?? b.tokens?.budget ?? NaN);
      return Number.isFinite(used) && Number.isFinite(budget) ? { used, budget } : null;
    } catch { return null; }
  }

  async listThreads(): Promise<AttachThread[]> {
    const res = await this.request('/api/chat/threads');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { threads: Array<Partial<AttachThread>> };
    return (body.threads || []).map((t) => ({
      id: String(t.id ?? ''),
      shortId: String(t.shortId ?? ''),
      alias: String(t.alias ?? t.title ?? 'session'),
      title: String(t.title ?? ''),
      updatedAt: String(t.updatedAt ?? ''),
    })).filter((t) => t.id.length > 0);
  }

  async getThread(id: string): Promise<AttachThreadMessage[]> {
    const res = await this.request(`/api/chat/threads/${encodeURIComponent(id)}`);
    if (!res.ok) return [];
    const body = await res.json() as { messages?: Array<Partial<AttachThreadMessage>> };
    return (body.messages || []).map((m) => ({
      id: String(m.id ?? `h_${Math.random().toString(36).slice(2, 8)}`),
      role: (m.role ?? 'system') as AttachThreadMessage['role'],
      kind: m.kind,
      content: String(m.content ?? ''),
      timestamp: String(m.timestamp ?? ''),
    }));
  }

  async createThread(): Promise<AttachThread | null> {
    try {
      const res = await this.request('/api/chat/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      const t = await res.json() as Partial<AttachThread>;
      if (!t.id) return null;
      return { id: t.id, shortId: String(t.shortId ?? ''), alias: String(t.alias ?? t.title ?? 'session'), title: String(t.title ?? ''), updatedAt: '' };
    } catch {
      return null;
    }
  }

  /** Active skills for the `#name` picker — the same data the main TUI splash loads. */
  async listSkills(): Promise<Array<{ name: string; description: string }>> {
    try {
      const res = await this.request('/api/skills');
      if (!res.ok) return [];
      const body = await res.json() as { skills?: Array<{ name?: string; description?: string; active?: boolean }> };
      return (body.skills ?? [])
        .filter((s) => s.active !== false)
        .map((s) => ({ name: String(s.name ?? ''), description: String(s.description ?? '') }))
        .filter((s) => s.name.length > 0);
    } catch {
      return [];
    }
  }

  /** Live bot roster for `/bot <id>` argument completion (main-TUI parity). */
  async listBots(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.request('/api/bots');
      if (!res.ok) return [];
      const body = await res.json() as { bots?: Array<{ id?: string; name?: string }> };
      return (body.bots ?? [])
        .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? '') }))
        .filter((b) => b.id.length > 0);
    } catch {
      return [];
    }
  }

  async send(content: string, sessionId?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    try {
      const res = await this.request('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      const body = await res.json() as { sessionId?: string };
      return { ok: true, sessionId: body.sessionId };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) };
    }
  }

  /** The owner's saved permission mode; null = never chosen, undefined = unknown (old runtime / error). */
  async permissionMode(): Promise<'allow-all' | 'ask-me' | null | undefined> {
    try {
      const res = await this.request('/api/chat/settings');
      if (!res.ok) return undefined;
      const body = await res.json() as { permissionMode?: unknown };
      if (!('permissionMode' in body)) return undefined;
      return body.permissionMode === 'allow-all' || body.permissionMode === 'ask-me' ? body.permissionMode : null;
    } catch { return undefined; }
  }

  async setPermissionMode(mode: 'allow-all' | 'ask-me'): Promise<boolean> {
    try {
      const res = await this.request('/api/chat/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bypassPermissions: mode === 'allow-all' }),
      });
      return res.ok;
    } catch { return false; }
  }

  async resolvePermission(id: string, action: string): Promise<boolean> {
    try {
      const res = await this.request(`/api/chat/permission/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Consume the SSE event feed (reconnecting with backoff until aborted).
   * Emits transport pseudo-events `attach_disconnected` / `attach_auth_error`
   * — the auth error is terminal (the token rotates on runtime restart, so
   * reconnecting cannot recover; the client must re-attach).
   */
  async streamEvents(sessionId: string, onEvent: (event: AttachEvent) => void, signal: AbortSignal): Promise<void> {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    let backoffMs = 1000;

    while (!signal.aborted) {
      try {
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
        const res = await this.request(`/api/chat/events${query}`, {
          headers: { Accept: 'text/event-stream' },
          signal,
        });
        if (res.status === 401) {
          onEvent({ type: 'attach_auth_error', data: {} });
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoffMs = 1000;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            let data: Record<string, unknown> = {};
            try { data = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {}; } catch { /* malformed frame */ }
            onEvent({ type: frame.event as AttachEventType, data });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        onEvent({ type: 'attach_disconnected', data: { message: String((err as Error)?.message || err) } });
      }
      // Backoff between reconnect attempts; abort cuts the wait short.
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), backoffMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
      });
      if (aborted) return;
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
  }
}

export interface AttachTarget {
  baseUrl: string;
  token: string;
  pid: number | null;
  /** Every live runtime pid (foreground and daemon) — a health answer from any other pid is a foreign process. */
  pids: number[];
}

const RUNTIME_BOOT_GRACE_MS = 15_000;

/**
 * Resolve the running runtime to attach to. Prefers the foreground TUI
 * process, falls back to the daemon. Returns null when no runtime is alive.
 */
export function findAttachTarget(): AttachTarget | null {
  const foreground = getForegroundRuntimeStatus();
  const daemon = getDaemonStatus();
  const pid = foreground.running ? foreground.pid : daemon.running ? daemon.pid : null;
  if (pid == null) return null;
  const token = readAttachToken();
  if (!token) return null; // runtime started before attach tokens existed, or web disabled
  const pids = [foreground.running ? foreground.pid : null, daemon.running ? daemon.pid : null].filter((p): p is number => typeof p === 'number');
  return { baseUrl: `http://127.0.0.1:${getWebPort()}`, token, pid, pids };
}

/**
 * Ride out a runtime that is still booting: the web endpoint comes up some
 * seconds into boot (channels and bot crew replay run first), so a one-shot
 * health check classified every slow boot as a broken runtime. Retries until
 * the grace window expires. An `auth` failure is not retryable — the token
 * rotated, which means the runtime restarted while we were reading it.
 */
export function isFinalHealthFailure(message: string): boolean {
  return message === 'auth' || message.startsWith('foreign:');
}

type HealthProbe = Pick<AttachClient, 'healthCheck'>;

/**
 * `client` may be a factory: a fresh client per attempt re-reads the attach
 * token, which a booting daemon rotates at bind time — then 'auth' is
 * retried until the grace window ends instead of failing on the first read.
 */
export async function waitForRuntimeHealth(
  client: HealthProbe | (() => HealthProbe | null),
  graceMs: number,
): Promise<{ ok: boolean; message?: string }> {
  const deadline = Date.now() + graceMs;
  const factory = typeof client === 'function';
  for (;;) {
    try {
      const probe = factory ? (client as () => HealthProbe | null)() : (client as HealthProbe);
      if (!probe) throw new Error('no attach token yet');
      await probe.healthCheck();
      return { ok: true };
    } catch (err) {
      const message = String((err as Error)?.message || err);
      if (message.startsWith('foreign:')) return { ok: false, message };
      if (message === 'auth' && !factory) return { ok: false, message };
      if (Date.now() >= deadline) return { ok: false, message };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** A runtime pid is alive but has not written its attach token yet (booting). */
async function waitForAttachTarget(graceMs: number): Promise<AttachTarget | null> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const target = findAttachTarget();
    if (target) return target;
    const alive = getForegroundRuntimeStatus().running || getDaemonStatus().running;
    if (!alive || Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export interface AttachRunOptions {
  /** Explicit `mercury attach` invocation — a failed attach sets exit code 1.
   *  Auto-attach launch paths leave the exit code alone so they can self-heal. */
  exitOnFailure?: boolean;
}

/** 'code' = the user asked for Mercury Code; MERCURY_BOOT_CODE is set and the caller boots the terminal runtime. */
export type AttachResult = 'attached' | 'unavailable' | 'unhealthy' | 'code';

/**
 * Entry point for `mercury attach` (and the auto-attach path when a second
 * `mercury` invocation finds the runtime already running). Connects, opens
 * the TUI, and returns when the user detaches (Ctrl+C). The runtime is
 * never touched from here.
 */
export async function runAttach(opts: AttachRunOptions = {}): Promise<AttachResult> {
  const { render } = await import('ink');
  const React = await import('react');
  const { AttachTui } = await import('../ui/attach-tui.js');
  const chalk = (await import('chalk')).default;

  const target = await waitForAttachTarget(RUNTIME_BOOT_GRACE_MS);
  if (!target) {
    const runtimeRunning = getForegroundRuntimeStatus().running || getDaemonStatus().running;
    if (!runtimeRunning) {
      console.error('  Mercury is not running. Start it with `mercury` or `mercury start`.');
    } else {
      console.error('  Cannot attach: web is disabled or no attach token was written at boot.');
      console.error('  Enable web (mercury doctor), or `mercury stop` and start again.');
    }
    if (opts.exitOnFailure) process.exitCode = 1;
    return 'unavailable';
  }

  // A fresh client per attempt: the token file is re-read, so a daemon that
  // rotates its token while booting is caught up with instead of refused.
  const freshClient = (): AttachClient | null => {
    const token = readAttachToken();
    return token ? new AttachClient(target.baseUrl, token, target.pids) : null;
  };
  let client = new AttachClient(target.baseUrl, target.token, target.pids);
  try {
    await client.healthCheck();
  } catch (firstErr) {
    let message = String((firstErr as Error)?.message || firstErr);
    let health: { ok: boolean; message?: string } = { ok: false, message };
    if (!message.startsWith('foreign:')) {
      console.log(chalk.dim(message === 'booting' ? '  Runtime is booting — attaching as soon as it is up...' : '  Waiting for the runtime to respond...'));
      health = await waitForRuntimeHealth(freshClient, RUNTIME_BOOT_GRACE_MS);
      if (health.ok) client = freshClient() ?? client;
    }
    if (health.ok === false) {
      message = health.message ?? message;
      if (message.startsWith('foreign:')) {
        const [, pid, version] = message.split(':');
        console.error(`  Port ${new URL(target.baseUrl).port} is owned by another Mercury (PID ${pid}${version ? `, v${version}` : ''}) — the runtime you launched (PID ${target.pid}) has no web listener.`);
        const drift = serviceDrift();
        if (drift) {
          console.error(`  Your login service starts that older install (${drift.installed}) on every login — run \`mercury service install\` to point it at this build, then \`mercury\` again.`);
        } else {
          console.error(`  Stop the other one (kill ${pid}) or set web.port in mercury.yaml, then run \`mercury\` again. Restarting would not help.`);
        }
        if (opts.exitOnFailure) process.exitCode = 1;
        return 'unavailable';
      }
      if (message === 'auth') {
        console.error('  The attach token rotated — the runtime restarted since the token was read.');
        console.error('  Run `mercury attach` again.');
      } else {
        console.error(`  Runtime (PID: ${target.pid}) is not responding at ${target.baseUrl} — likely hung, or its web server never bound.`);
        console.error(`  Recover with \`mercury stop\`, then launch again. Daemon log: ${getDaemonStatus().logPath}`);
      }
      if (opts.exitOnFailure) process.exitCode = 1;
      return 'unhealthy';
    }
  }

  let handoff: { kind: 'code'; dir?: string } | null = null;
  const info = await client.healthCheck().catch(() => null);
  const instance = render(React.createElement(AttachTui, {
    client,
    pid: target.pid,
    version: info?.version || undefined,
    onExit: () => {},
    onHandoff: (h) => { handoff = h; },
  }));
  await instance.waitUntilExit();
  if (handoff) {
    const h: { kind: 'code'; dir?: string } = handoff;
    const { resolve } = await import('node:path');
    const { existsSync, statSync } = await import('node:fs');
    const dir = h.dir ? resolve(h.dir.replace(/^~(?=$|[\\/])/, process.env.HOME ?? '')) : '';
    if (dir && !(existsSync(dir) && statSync(dir).isDirectory())) {
      console.log(chalk.yellow(`  Not a directory: ${dir} — opening Mercury Code here instead.`));
    }
    process.env.MERCURY_BOOT_CODE = dir && existsSync(dir) ? dir : '1';
    console.log(chalk.dim('  Opening Mercury Code in this terminal (the runtime keeps running in the background)…'));
    return 'code';
  }
  console.log(chalk.dim(`  Detached. Runtime still running${target.pid ? ` (PID ${target.pid})` : ''} — \`mercury stop\` stops it.`));
  return 'attached';
}