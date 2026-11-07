import { describe, expect, it } from 'vitest';
import type { ScheduleInfo } from './pulse';
import { scheduleDetail, scheduleIsActive } from './schedule-status';

const once: ScheduleInfo = { id: 'one', description: 'A reminder', delaySeconds: 60, executeAt: '2026-11-06T12:00:00Z' };
const run = (status: 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped' | 'dispatched') => ({ id: status, status, startedAt: '2026-11-06T12:00:00Z' });

describe('durable schedules in the status bar', () => {
  it('counts pending and running work, excluding retained terminal one-shots and paused work', () => {
    expect(scheduleIsActive(once)).toBe(true);
    expect(scheduleIsActive({ ...once, lastRun: run('running') })).toBe(true);
    for (const status of ['completed', 'failed', 'interrupted', 'skipped', 'dispatched'] as const) {
      expect(scheduleIsActive({ ...once, lastRun: run(status) })).toBe(false);
    }
    expect(scheduleIsActive({ ...once, cron: '* * * * *', lastRun: run('completed') })).toBe(true);
    expect(scheduleIsActive({ ...once, cron: '* * * * *', paused: true })).toBe(false);
  });

  it('uses the absolute due time instead of claiming the original delay remains', () => {
    expect(scheduleDetail(once)).toContain('pending · due ');
    expect(scheduleDetail(once)).not.toContain('in 60s');
    expect(scheduleDetail({ ...once, paused: true, lastRun: run('failed') })).toContain('failed · paused · was due ');
    expect(scheduleDetail({ ...once, lastRun: run('dispatched') })).toContain('dispatched to bot queue');
  });

  it('shows the recurring timezone and preserves older-runtime timestamps', () => {
    expect(scheduleDetail({ ...once, cron: '*/5 * * * *', timezone: 'Europe/London', lastRun: run('completed') })).toContain('scheduled · last run completed · every 5 min · Europe/London');
    expect(scheduleIsActive({ ...once, lastRun: '2026-11-06T12:00:00Z' })).toBe(true);
    expect(scheduleDetail({ ...once, executeAt: undefined, lastRun: '2026-11-06T12:00:00Z' })).toBe('pending · delay 60s');
  });
});
