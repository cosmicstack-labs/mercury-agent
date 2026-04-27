import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let mercuryHome = '';

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

import { TokenBudget } from './tokens.js';

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
});