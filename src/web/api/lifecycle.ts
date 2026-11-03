import { Hono } from 'hono';
import { authenticateRequest, isThisComputer } from '../middleware.js';
import { requireOwner } from '../owner-gate.js';
import { spawnDetachedRestart } from '../../cli/daemon.js';

let restartSpawner: () => boolean = spawnDetachedRestart;
/** Test seam. */
export function setRestartSpawner(fn: () => boolean): void { restartSpawner = fn; }

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

/**
 * Apply saved configuration by restarting the runtime. On this computer it
 * just happens; from another device the owner approves it first. Providers, channels and keys are read at boot,
 * so this is how a dashboard save actually takes effect.
 */
lifecycle.post('/api/restart', (c) => {
  if (!isThisComputer(c)) {
    const wait = requireOwner(c, { id: 'runtime.restart', title: 'Restart Mercury' });
    if (wait) return wait;
  }
  if (!restartSpawner()) {
    return c.json({ error: 'Could not start the restart helper — run `mercury restart` in a terminal' }, 503);
  }
  return c.json({ ok: true, pid: process.pid, message: 'Restarting — back in a few seconds' }, 202);
});

lifecycle.post('/api/shutdown', (c) => {
  // Only a process on this computer holding the attach token (`mercury stop`).
  if (authenticateRequest(c)?.kind !== 'attach') {
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
