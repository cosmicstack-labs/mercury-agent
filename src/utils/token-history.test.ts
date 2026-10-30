import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historySince, localDay, readHistory, recordDay, seedToday } from './token-history.js';

describe('token history', () => {
  let home: string;
  const previous = process.env.MERCURY_HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mercury-history-')); process.env.MERCURY_HOME = home; });
  afterEach(() => { if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous; rmSync(home, { recursive: true, force: true }); });

  it('adds requests to their local day and fills empty days', () => {
    const now = new Date(2026, 9, 27, 15, 0, 0);
    const yesterday = new Date(2026, 9, 26, 23, 30, 0).getTime();
    recordDay(100, 20, 120, yesterday);
    recordDay(50, 10, 60, now.getTime());
    recordDay(5, 5, 0, now.getTime());
    const rows = readHistory(3, now);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(rows[0]).toMatchObject({ tokens: 0, requests: 0 });
    expect(rows[1]).toMatchObject({ tokens: 120, inputTokens: 100, outputTokens: 20, requests: 1 });
    expect(rows[2]).toMatchObject({ tokens: 70, requests: 2 });
    expect(historySince()).toBe('2026-10-26');
  });

  it('seeds today once, and never over an existing row', () => {
    seedToday(500, 400, 100, 3);
    seedToday(9999, 1, 1, 1);
    const today = readHistory(1)[0];
    expect(today.date).toBe(localDay());
    expect(today.tokens).toBe(500);
  });
});
