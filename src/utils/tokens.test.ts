import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TokenBudget } from './tokens.js';
import type { MercuryConfig } from './config.js';

let mercuryHome = '';

/** Only the slice TokenBudget reads: a whole config would be noise in every assertion. */
const configWith = (dailyBudget: number) => ({ tokens: { dailyBudget } } as unknown as MercuryConfig);

vi.mock('./config.js', () => ({
  getMercuryHome: () => mercuryHome,
  saveConfig: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('TokenBudget hardening', () => {
  beforeEach(() => {
    mercuryHome = mkdtempSync(join(tmpdir(), 'mercury-token-test-'));
  });

  afterEach(() => {
    if (mercuryHome) {
      rmSync(mercuryHome, { recursive: true, force: true });
    }
  });

  it('does not poison daily usage when token values are invalid', () => {
    const budget = new TokenBudget({ tokens: { dailyBudget: 200_000 } } as any);

    budget.recordUsage({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: Number.NaN,
      outputTokens: Number.NaN,
      totalTokens: Number.NaN,
      channelType: 'cli',
    });

    expect(budget.getDailyUsed()).toBe(0);
    expect(budget.getStatusText()).not.toContain('NaN');

    budget.recordUsage({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      channelType: 'cli',
    });

    expect(budget.getDailyUsed()).toBe(150);
    expect(budget.getRemaining()).toBe(199_850);
  });

  it('repairs corrupted persisted usage data on restore', () => {
    const usagePath = join(mercuryHome, 'token-usage.json');
    const today = new Date().toISOString().split('T')[0];

    writeFileSync(usagePath, JSON.stringify({
      dailyUsed: null,
      dailyBudget: 200000,
      lastResetDate: today,
      requestLog: [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          channelType: 'cli',
          timestamp: Date.now(),
        },
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          channelType: 'cli',
          timestamp: Date.now(),
        },
      ],
    }), 'utf-8');

    const budget = new TokenBudget({ tokens: { dailyBudget: 200_000 } } as any);

    expect(budget.getDailyUsed()).toBe(100);
    expect(budget.getStatusText()).toContain('100 / 200,000 used');
    expect(budget.getStatusText()).not.toContain('NaN');

    const persisted = JSON.parse(readFileSync(usagePath, 'utf-8')) as { dailyUsed: number };
    expect(persisted.dailyUsed).toBe(100);
  });

  it('reads a zero budget as no ceiling, not as no answers', () => {
    const budget = new TokenBudget(configWith(0));
    budget.recordUsage({
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1_000,
      channelType: 'cli',
    });

    expect(budget.isOverBudget()).toBe(false);
    expect(budget.canAfford(5_000_000)).toBe(true);
    expect(budget.getStatusText()).toContain('no daily ceiling');
    expect(budget.getStatusText()).not.toContain('0 remaining');
  });

  it('still refuses once a real ceiling is crossed', () => {
    const budget = new TokenBudget(configWith(1_000));
    budget.recordUsage({
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1_000,
      channelType: 'cli',
    });

    expect(budget.canAfford(1)).toBe(false);
    expect(budget.isOverBudget()).toBe(true);
    expect(budget.getRemaining()).toBe(0);
  });
});
describe('TokenBudget cache weighting (tokens.cachedWeight)', () => {
  beforeEach(() => {
    mercuryHome = mkdtempSync(join(tmpdir(), 'mercury-token-test-'));
  });

  afterEach(() => {
    if (mercuryHome) rmSync(mercuryHome, { recursive: true, force: true });
  });

  const turn = {
    provider: 'litellm',
    model: 'gpt-5',
    inputTokens: 100_000,
    outputTokens: 2_000,
    totalTokens: 102_000,
    cachedInputTokens: 90_000,
    noCacheInputTokens: 10_000,
    channelType: 'cli',
  };
  const withWeight = (cachedWeight: unknown) => ({ tokens: { dailyBudget: 1_000_000, cachedWeight } } as unknown as MercuryConfig);

  it('counts every token when the weight is unset (default 1)', () => {
    const budget = new TokenBudget(configWith(1_000_000));
    budget.recordUsage(turn);
    expect(budget.getDailyUsed()).toBe(102_000);
  });

  it('counts cache hits at the configured weight', () => {
    const budget = new TokenBudget(withWeight(0.1));
    budget.recordUsage(turn);
    // 10,000 uncached + 2,000 out + 90,000 × 0.1
    expect(budget.getDailyUsed()).toBe(21_000);
  });

  it('excludes cache hits at weight 0', () => {
    const budget = new TokenBudget(withWeight(0));
    budget.recordUsage(turn);
    expect(budget.getDailyUsed()).toBe(12_000);
  });

  it('clamps out-of-range weights and treats non-numbers as 1', () => {
    const over = new TokenBudget(withWeight(5));
    over.recordUsage(turn);
    expect(over.getDailyUsed()).toBe(102_000);

    rmSync(join(mercuryHome, 'token-usage.json'), { force: true });
    const under = new TokenBudget(withWeight(-2));
    under.recordUsage(turn);
    expect(under.getDailyUsed()).toBe(12_000);

    rmSync(join(mercuryHome, 'token-usage.json'), { force: true });
    const junk = new TokenBudget(withWeight('cheap'));
    junk.recordUsage(turn);
    expect(junk.getDailyUsed()).toBe(102_000);
  });

  it('counts requests without a cache split at their plain total', () => {
    const budget = new TokenBudget(withWeight(0.1));
    budget.recordUsage({ provider: 'openai', model: 'm', inputTokens: 400, outputTokens: 100, totalTokens: 500, channelType: 'internal' });
    expect(budget.getDailyUsed()).toBe(500);
  });

  it('shows the cache split and the weight in /budget', () => {
    const budget = new TokenBudget(withWeight(0.1));
    expect(budget.getCacheSplitText()).toBe('');
    budget.recordUsage(turn);
    expect(budget.getCacheSplitText()).toBe('Today: 100,000 in (90,000 cached · 90%, counted at 0.1) · 10,000 uncached · 2,000 out');
  });

  it('leaves the weight out of the /budget line at the default', () => {
    const budget = new TokenBudget(configWith(1_000_000));
    budget.recordUsage(turn);
    expect(budget.getCacheSplitText()).toBe('Today: 100,000 in (90,000 cached · 90%) · 10,000 uncached · 2,000 out');
  });

  it('keeps the split and the weighted total across a restart', () => {
    const first = new TokenBudget(withWeight(0.1));
    first.recordUsage(turn);
    const second = new TokenBudget(withWeight(0.1));
    expect(second.getDailyUsed()).toBe(21_000);
    expect(second.getDailySplit()).toEqual({ inputTokens: 100_000, cachedInputTokens: 90_000, noCacheInputTokens: 10_000, outputTokens: 2_000 });
  });

  it('clears the split on reset', () => {
    const budget = new TokenBudget(withWeight(0.1));
    budget.recordUsage(turn);
    budget.resetUsage();
    expect(budget.getCacheSplitText()).toBe('');
  });
});
