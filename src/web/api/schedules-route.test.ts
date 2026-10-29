import { describe, expect, it, vi } from 'vitest';
import system, { setScheduler } from './system.js';

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
