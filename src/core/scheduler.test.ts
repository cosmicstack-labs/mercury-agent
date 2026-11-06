import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MercuryConfig } from '../utils/config.js';
import { loadSchedules, saveSchedules, Scheduler, type ScheduledTaskManifest } from './scheduler.js';

const config = { heartbeat: { intervalMinutes: 30 } } as MercuryConfig;
const NOW = new Date('2026-11-06T13:59:58Z');
let home: string;
let schedulers: Scheduler[];
function create(handler: ConstructorParameters<typeof Scheduler>[1] = async () => {}) {
  const scheduler = new Scheduler(config, handler);
  schedulers.push(scheduler);
  return scheduler;
}
function task(overrides: Partial<ScheduledTaskManifest> = {}): ScheduledTaskManifest {
  return { id: 'reminder', description: 'Remind me', prompt: 'Notify me', delaySeconds: 1, executeAt: new Date(Date.now() + 1000).toISOString(), createdAt: NOW.toISOString(), ...overrides };
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-scheduler-'));
  vi.stubEnv('MERCURY_HOME', home);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  schedulers = [];
});
afterEach(() => {
  schedulers.forEach((scheduler) => scheduler.stopAll());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('durable schedules', () => {
  it('persists running intent before invoking an effect, then retains confirmed completion', async () => {
    const handler = vi.fn(async () => {
      expect(loadSchedules()[0].lastRun?.status).toBe('running');
    });
    const scheduler = create(handler);
    scheduler.addDelayedTask(task());
    scheduler.persistSchedules();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledOnce();
    expect(loadSchedules()[0].lastRun).toMatchObject({ status: 'completed', finishedAt: new Date().toISOString() });
    if (process.platform !== 'win32') expect(statSync(join(home, 'schedules.yaml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'schedules.yaml'), 'utf8')).toContain('completed');
  });

  it('retains a failed one-shot and never repeats it on restart', async () => {
    const handler = vi.fn(async () => { throw new Error('Connection lost after sending'); });
    const scheduler = create(handler);
    scheduler.addDelayedTask(task({ missedRunPolicy: 'run_once' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadSchedules()[0]).toMatchObject({ paused: true, lastRun: { status: 'failed', error: 'Connection lost after sending' } });
    scheduler.stopAll();
    create(handler).restorePersistedTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('marks unconfirmed work interrupted and pauses it even with catch-up enabled', async () => {
    const handler = vi.fn(async () => 'queued' as const);
    const first = create(handler);
    first.addDelayedTask(task({ missedRunPolicy: 'run_once' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadSchedules()[0].lastRun?.status).toBe('running');
    first.stopAll();
    const restarted = create(handler);
    restarted.restorePersistedTasks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledOnce();
    expect(restarted.getManifest('reminder')).toMatchObject({ paused: true, lastRun: { status: 'interrupted' } });
    // A metadata-only edit must not turn uncertain side effects into a retry.
    restarted.replaceManifest({ ...restarted.getManifest('reminder')!, description: 'renamed' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).toHaveBeenCalledOnce();
    restarted.replaceManifest(restarted.getManifest('reminder')!, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('skips legacy overdue one-shots but catches up explicitly opted-in work exactly once', async () => {
    saveSchedules([
      task({ id: 'legacy', executeAt: new Date(Date.now() - 1000).toISOString() }),
      task({ id: 'catch-up', missedRunPolicy: 'run_once', executeAt: new Date(Date.now() - 1000).toISOString() }),
    ]);
    const handler = vi.fn(async () => {});
    const first = create(handler);
    first.restorePersistedTasks();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'catch-up' }), expect.any(String));
    expect(first.getManifest('legacy')?.lastRun?.status).toBe('skipped');
    first.stopAll();
    create(handler).restorePersistedTasks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not overlap a main-agent run that has only been queued', async () => {
    const handler = vi.fn(async () => 'queued' as const);
    const scheduler = create(handler);
    scheduler.addPersistedTask(task({ delaySeconds: undefined, executeAt: undefined, cron: '* * * * * *' }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(handler).toHaveBeenCalledOnce();
    const runId = scheduler.getManifest('reminder')!.lastRun!.id;
    scheduler.finishRun('reminder', runId, 'completed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    scheduler.finishRun('reminder', runId, 'failed', 'stale result');
    expect(scheduler.getManifest('reminder')!.lastRun!.status).toBe('running');
  });

  it('fires cron in the selected IANA zone, independent of the host timezone', async () => {
    const handler = vi.fn(async () => {});
    create(handler).addPersistedTask(task({ delaySeconds: undefined, executeAt: undefined, cron: '0 9 * * *', timezone: 'America/New_York' }));
    await vi.advanceTimersByTimeAsync(2000); // 14:00 UTC = 09:00 EST
    expect(handler).toHaveBeenCalledOnce();
  });

  it('chunks delays beyond Node’s timer limit without firing early', async () => {
    const handler = vi.fn(async () => {});
    const delaySeconds = 30 * 24 * 3600;
    create(handler).addDelayedTask(task({ delaySeconds, executeAt: new Date(Date.now() + delaySeconds * 1000).toISOString() }));
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(delaySeconds * 1000 - (2 ** 31 - 1));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('bounds resolved one-shot history while retaining active and unresolved work', () => {
    const finished = Array.from({ length: 105 }, (_, i) => task({ id: `done-${i}`, lastRun: { id: String(i), status: 'completed', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() } }));
    saveSchedules([...finished, task({ id: 'pending' }), task({ id: 'failed', paused: true, lastRun: { id: 'f', status: 'failed', startedAt: NOW.toISOString() } })]);
    const scheduler = create();
    scheduler.restorePersistedTasks();
    expect(scheduler.getManifests()).toHaveLength(102);
    expect(scheduler.getManifest('pending')).not.toBeNull();
    expect(scheduler.getManifest('failed')).not.toBeNull();
  });

  it('leaves malformed persisted schedules untouched instead of overwriting recovery evidence', () => {
    const path = join(home, 'schedules.yaml');
    const invalid = 'tasks: [malformed';
    writeFileSync(path, invalid);
    create().restorePersistedTasks();
    expect(readFileSync(path, 'utf8')).toBe(invalid);
  });

  it('validates before changing an existing schedule', () => {
    const scheduler = create();
    scheduler.addDelayedTask(task());
    expect(() => scheduler.replaceManifest(task({ delaySeconds: Infinity }))).toThrow();
    expect(() => scheduler.replaceManifest(task({ timezone: 'Mars/Olympus' }))).toThrow();
    expect(scheduler.getManifest('reminder')?.delaySeconds).toBe(1);
  });
});
