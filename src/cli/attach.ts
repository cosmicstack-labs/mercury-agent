import { getForegroundRuntimeStatus, getDaemonStatus } from './daemon.js';
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

export class AttachClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
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

  /** Cheap authenticated GET to verify the runtime + token before opening the TUI. */
  async healthCheck(timeoutMs = 3000): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.request('/api/chat/models', { signal: controller.signal });
      if (res.status === 401) throw new Error('auth');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
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
}

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
  return { baseUrl: `http://127.0.0.1:${getWebPort()}`, token, pid };
}

/**
 * Entry point for `mercury attach` (and the auto-attach path when a second
 * `mercury` invocation finds the runtime already running). Connects, opens
 * the TUI, and returns when the user detaches (Ctrl+C). The runtime is
 * never touched from here.
 */
export async function runAttach(): Promise<void> {
  const { render } = await import('ink');
  const React = await import('react');
  const { AttachTui } = await import('../ui/attach-tui.js');
  const chalk = (await import('chalk')).default;

  const target = findAttachTarget();
  if (!target) {
    const runtimeRunning = getForegroundRuntimeStatus().running || getDaemonStatus().running;
    if (!runtimeRunning) {
      console.error('  Mercury is not running. Start it with `mercury` or `mercury start`.');
    } else {
      console.error('  Cannot attach: web is disabled or no attach token was written at boot.');
      console.error('  Enable web (mercury doctor), or `mercury stop` and start again.');
    }
    process.exitCode = 1;
    return;
  }

  const client = new AttachClient(target.baseUrl, target.token);
  try {
    await client.healthCheck();
  } catch (err) {
    const message = String((err as Error)?.message || err);
    console.error(`  Runtime is not responding at ${target.baseUrl} (${message}).`);
    if (message === 'auth') {
      console.error('  The attach token rotated — the runtime restarted since the token was read.');
      console.error('  Run `mercury attach` again.');
    }
    process.exitCode = 1;
    return;
  }

  const instance = render(React.createElement(AttachTui, {
    client,
    pid: target.pid,
    onExit: () => {},
  }));
  await instance.waitUntilExit();
  console.log(chalk.dim(`  Detached. Runtime still running${target.pid ? ` (PID ${target.pid})` : ''} — \`mercury stop\` stops it.`));
}