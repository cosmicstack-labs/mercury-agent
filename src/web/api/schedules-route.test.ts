import { afterEach, describe, expect, it, vi } from 'vitest';
import system, { setScheduler } from './system.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../../core/scheduler.js';
import type { MercuryConfig } from '../../utils/config.js';

/** The status bar's schedule list deletes through this route. */
function fakeScheduler(ids: string[]) {
  const manifests = new Map(ids.map((id) => [id, { id, description: `task ${id}`, cron: '0 9 * * *', createdAt: '2026-10-27' }]));
  return {
    getManifests: () => [...manifests.values()],
    getManifest: (id: string) => manifests.get(id) ?? null,
    removeTask: vi.fn((id: string) => { manifests.delete(id); }),
    persistSchedules: vi.fn(),
  };
}

describe('DELETE /api/schedules/:id', () => {
  it('removes the schedule and saves, so it stays gone after a restart', async () => {
    const s = fakeScheduler(['a', 'b']);
    setScheduler(s as never);
    const res = await system.request('http://127.0.0.1/api/schedules/a', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(s.removeTask).toHaveBeenCalledWith('a');
    expect(s.persistSchedules).toHaveBeenCalled();
    const left = (await (await system.request('http://127.0.0.1/api/schedules')).json()) as { schedules: Array<{ id: string }> };
    expect(left.schedules.map((x) => x.id)).toEqual(['b']);
  });

  it('a schedule that is already gone is a 404, not a crash', async () => {
    setScheduler(fakeScheduler([]) as never);
    expect((await system.request('http://127.0.0.1/api/schedules/zzz', { method: 'DELETE' })).status).toBe(404);
  });
});

const dirs: string[] = [];
const realSchedulers: Scheduler[] = [];
afterEach(() => {
  realSchedulers.splice(0).forEach((scheduler) => scheduler.stopAll());
  setScheduler(null);
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function realSchedule() {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-route-'));
  dirs.push(dir);
  vi.stubEnv('MERCURY_HOME', dir);
  const scheduler = new Scheduler({ heartbeat: { intervalMinutes: 30 } } as MercuryConfig);
  realSchedulers.push(scheduler);
  scheduler.addDelayedTask({ id: 'failed', description: 'Remind me', prompt: 'Notify', delaySeconds: 60, executeAt: '2026-01-01T00:00:00Z', createdAt: '2025-12-31T00:00:00Z', paused: true, lastRun: { id: 'run', status: 'failed', startedAt: '2026-01-01T00:00:00Z', error: 'Unknown send outcome' } });
  setScheduler(scheduler);
  return scheduler;
}
function update(body: Record<string, unknown>) {
  return system.request('http://127.0.0.1/api/schedules/failed', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
describe('schedule policy editing', () => {
  it('keeps failed work paused on metadata edits; explicit resume rearms it', async () => {
    const scheduler = realSchedule();
    expect((await update({ description: 'Renamed', missedRunPolicy: 'run_once' })).status).toBe(200);
    expect(scheduler.getManifest('failed')).toMatchObject({ paused: true, lastRun: { status: 'failed' }, executeAt: '2026-01-01T00:00:00Z' });
    expect((await update({ resume: true, delaySeconds: 300 })).status).toBe(200);
    expect(scheduler.getManifest('failed')).toMatchObject({ paused: false, delaySeconds: 300 });
    expect(scheduler.getManifest('failed')?.lastRun).toBeUndefined();
    expect(Date.parse(scheduler.getManifest('failed')!.executeAt!)).toBeGreaterThan(Date.now());
  });

  it.each([{ timezone: 'Not/A_Zone' }, { missedRunPolicy: 'replay_all' }, { delaySeconds: -1 }, { delaySeconds: '60' }, { resume: 'yes' }, { cron: '0 9 * * *', delaySeconds: 60 }])('rejects invalid options without changing the task: %o', async (body) => {
    const scheduler = realSchedule();
    expect((await update(body)).status).toBe(400);
    expect(scheduler.getManifest('failed')).toMatchObject({ description: 'Remind me', paused: true, lastRun: { status: 'failed' } });
  });
});
