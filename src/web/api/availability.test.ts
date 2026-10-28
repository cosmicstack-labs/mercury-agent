import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import system, { setScheduler } from './system.js';
import status from './status.js';
import type { Scheduler } from '../../core/scheduler.js';

/**
 * The witness key.
 *
 * Every one of these routes can answer with a shape that a client decodes into plausible defaults —
 * zeros, "off", "unlimited", "no routines". A body is only evidence of the server's state when it
 * says so; `available` is that statement. These tests pin both directions: the honest answer, and
 * the one that admits it has none.
 */

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-availability-'));
  process.env.MERCURY_HOME = home;
});

afterEach(() => {
  setScheduler(null);
  delete process.env.MERCURY_HOME;
  rmSync(home, { recursive: true, force: true });
});

function writeUsage(payload: unknown): void {
  writeFileSync(join(home, 'token-usage.json'), JSON.stringify(payload));
}

describe('GET /api/status', () => {
  it('says it is available and gives the uptime as a number', async () => {
    const res = await status.request('/api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.available).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(Number.isFinite(body.uptimeSeconds)).toBe(true);
    // The field the dashboard already read stays, with the same number.
    expect(body.uptime).toBe(body.uptimeSeconds);
  });
});

describe('GET /api/usage', () => {
  it('is available when the tracker holds a real record', async () => {
    writeUsage({
      dailyUsed: 1234,
      dailyBudget: 80000000,
      lastResetDate: '2026-10-28',
      requestLog: [
        { timestamp: 1, provider: 'deepseek', model: 'flash', inputTokens: 10, outputTokens: 2, totalTokens: 12, channelType: 'internal' },
      ],
    });

    const res = await system.request('/api/usage');
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.available).toBe(true);
    expect(body.dailyUsed).toBe(1234);
    expect(body.dailyBudget).toBe(80000000);
  });

  it('is NOT available when the tracker exists and cannot be read', async () => {
    // A truncated file is the case that used to read as "0 used, unlimited budget".
    writeFileSync(join(home, 'token-usage.json'), '{"dailyUsed": 12');

    const res = await system.request('/api/usage');
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it('is available on a fresh instance with no tracker yet', async () => {
    const res = await system.request('/api/usage');
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.available).toBe(true);
    expect(body.dailyUsed).toBe(0);
  });
});

describe('GET /api/schedules', () => {
  it('admits it has no scheduler instead of reporting an empty schedule list', async () => {
    const res = await system.request('/api/schedules');
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.schedules).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('is available once a scheduler is attached', async () => {
    const fake = { getManifests: () => [] } as unknown as Scheduler;
    setScheduler(fake);

    const body = (await (await system.request('/api/schedules')).json()) as Record<string, unknown>;
    expect(body.available).toBe(true);
  });
});
