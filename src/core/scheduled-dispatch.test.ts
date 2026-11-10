import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { WorkLedger } from './work-ledger.js';
import { Scheduler, type ScheduledTaskManifest } from './scheduler.js';
import type { MercuryConfig } from '../utils/config.js';
import { bareTurnFields } from './testing/fake-turns.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** Exercise the real scheduler -> internal prompt -> durable queue -> finalization path. */
function harness(fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-dispatch-'));
  dirs.push(dir);
  vi.stubEnv('MERCURY_HOME', dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const agent = Object.create(Agent.prototype) as Agent;
  const internal = agent as unknown as {
    currentWorkKey: string;
    handleScheduledTask(manifest: ScheduledTaskManifest, runId: string): Promise<'queued'>;
    processQueue(): void;
  };
  const scheduler = new Scheduler({ heartbeat: { intervalMinutes: 30 } } as MercuryConfig,
    (manifest, runId) => internal.handleScheduledTask(manifest, runId));
  const effect = vi.fn();
  Object.assign(agent, {
    ...bareTurnFields(),
    scheduler, workLedger, running: false,
    channels: { get: () => undefined, getNotificationChannel: () => undefined },
    globalLifecycle: { is: () => true },
    announceQueue: () => {},
    withSessionProgramming: (_msg: unknown, run: () => Promise<void>) => run(),
    handleMessage: async () => {
      effect();
      if (fail) throw new Error('Lost connection after performing an effect');
      workLedger.markCompleted(internal.currentWorkKey, 'Done');
    },
  });
  return { agent, internal, scheduler, effect, workLedger };
}

describe('scheduled main-agent dispatch', () => {
  it.each([false, true])('tracks execution rather than enqueue acceptance (failure=%s)', async (fail) => {
    vi.useFakeTimers();
    const { agent, internal, scheduler, effect } = harness(fail);
    scheduler.addDelayedTask({ id: 'scheduled', description: 'Run work', prompt: '/a prompt is not a slash command', delaySeconds: 1, createdAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.getManifest('scheduled')?.lastRun?.status).toBe('running');
    expect(effect).not.toHaveBeenCalled();
    Object.assign(agent, { running: true });
    internal.processQueue();
    await agent.whenIdle();
    expect(effect).toHaveBeenCalledOnce();
    expect(scheduler.getManifest('scheduled')?.lastRun?.status).toBe(fail ? 'failed' : 'completed');
    scheduler.stopAll();
    scheduler.restorePersistedTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(effect).toHaveBeenCalledOnce();
    scheduler.stopAll();
  });
});
