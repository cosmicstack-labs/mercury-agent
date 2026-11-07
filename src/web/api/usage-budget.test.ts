import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import system from './system.js';
import { updateStatus } from './status.js';

/**
 * The number the console reads for "how much is left today".
 *
 * `/api/usage` used to answer with the budget recorded in `token-usage.json` — a snapshot written
 * the last time tokens were counted — so raising the limit left the console showing the old one,
 * with a `remaining` computed from it, until some turn happened to rewrite the file. These tests
 * pin that the runtime's budget wins, and that a tracker without one still answers.
 */

let home = '';

/** The budget a bare test runtime starts with, restored after each case. */
const DEFAULT_BUDGET = 1_000_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-usage-budget-'));
  process.env.MERCURY_HOME = home;
});

afterEach(() => {
  updateStatus({ tokenBudget: DEFAULT_BUDGET });
  delete process.env.MERCURY_HOME;
  rmSync(home, { recursive: true, force: true });
});

const writeUsage = (payload: unknown) => writeFileSync(join(home, 'token-usage.json'), JSON.stringify(payload));

const usage = async () => {
  const res = await system.request('/api/usage');
  return (await res.json()) as Record<string, number | boolean>;
};

describe('GET /api/usage budget', () => {
  it('reports the budget the runtime enforces, not the snapshot in the tracker', async () => {
    writeUsage({ dailyUsed: 152_867_556, dailyBudget: 80_000_000, lastResetDate: '2026-10-28', requestLog: [] });
    updateStatus({ tokenBudget: 500_000_000 });

    const body = await usage();

    expect(body.dailyBudget).toBe(500_000_000);
    expect(body.remaining).toBe(500_000_000 - 152_867_556);
  });

  it('falls back to the tracker when the runtime announced no budget', async () => {
    writeUsage({ dailyUsed: 10, dailyBudget: 80_000_000, lastResetDate: '2026-10-28', requestLog: [] });
    updateStatus({ tokenBudget: 0 });

    const body = await usage();

    expect(body.dailyBudget).toBe(80_000_000);
    expect(body.remaining).toBe(80_000_000 - 10);
  });

  it('counts what has been used once, and does not invent a negative remainder', async () => {
    writeUsage({ dailyUsed: 600_000_000, dailyBudget: 1, lastResetDate: '2026-10-28', requestLog: [] });
    updateStatus({ tokenBudget: 500_000_000 });

    const body = await usage();

    expect(body.dailyBudget).toBe(500_000_000);
    expect(body.remaining).toBe(0);
  });
});
