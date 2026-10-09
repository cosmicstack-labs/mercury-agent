import { Hono } from 'hono';
import { readAttachToken } from '../auth.js';
import { isLoopbackRequest } from '../middleware.js';

/**
 * Local, authenticated shutdown for `mercury stop` / `restart` / `upgrade`.
 *
 * Why: on Windows `process.kill(pid)` is TerminateProcess — no signal, so
 * the runtime's `shutdown()` (channel notices, memory consolidation, SQLite
 * handle release, pid-file cleanup) never runs. The CLI asks over HTTP
 * instead and only falls back to killing when this endpoint is unreachable.
 *
 * Guarded twice over the ordinary `authGuard`: loopback peers only, and the
 * machine-local attach token specifically (a browser web session — which
 * may come from the LAN — cannot stop the daemon).
 */
const lifecycle = new Hono();

let shutdownHandler: (() => void) | null = null;

/** Registered by the runtime once its `shutdown()` exists. */
export function setShutdownHandler(handler: (() => void) | null): void {
  shutdownHandler = handler;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

lifecycle.post('/api/shutdown', (c) => {
  if (!isLoopbackRequest(c)) {
    return c.json({ error: 'Shutdown is only accepted from this machine' }, 403);
  }
  const token = bearerToken(c.req.header('Authorization'));
  const expected = readAttachToken();
  if (!token || !expected || token !== expected) {
    return c.json({ error: 'Shutdown requires the local attach token' }, 403);
  }
  if (!shutdownHandler) {
    return c.json({ error: 'Runtime is not ready to shut down yet' }, 503);
  }
  const handler = shutdownHandler;
  // Reply first, then shut down — the caller needs the ack to know that
  // the graceful path was taken before it starts waiting on the pid.
  setTimeout(() => { try { handler(); } catch { /* shutdown() handles its own errors */ } }, 20);
  return c.json({ ok: true, pid: process.pid }, 202);
});

export default lifecycle;
