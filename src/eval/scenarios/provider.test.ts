import { afterAll, describe, expect, it } from 'vitest';
import { EvalHarness } from '../runner.js';
import { textStep } from '../fixture.js';

describe('eval · provider fallback', () => {
  afterAll(async () => (await import('../env.js')).removeEvalRoot());

  it('first provider throws, second answers; the next turn starts on the configured default again', async () => {
    const harness = await EvalHarness.create({
      name: 'provider-fallback',
      providers: [{ name: 'primary', failFirst: 1, failWith: 'primary: 503 Service Unavailable' }, { name: 'backup' }],
      turns: [],
    });
    try {
      const first = await harness.runTurn({
        message: 'what should I cook tonight',
        steps: [textStep('Try a mushroom risotto.')],
        expect: { deliveredCount: 1, usedProvider: 'backup', finalTextIncludes: ['risotto'] },
      });
      expect(first.failures).toEqual([]);
      expect(first.providerCalls.map((c) => [c.provider, c.error ? 'error' : 'ok'])).toEqual([['primary', 'error'], ['backup', 'ok']]);
      expect(first.guard.providerNotices.some((n) => n.includes('switching to `backup`'))).toBe(true);
      expect(first.guard.providerNotices.some((n) => n.includes('served by `backup`'))).toBe(true);
      expect(first.timings.steps[0].error).toContain('503');
      expect(harness.providerRegistry.getLastSuccessful()).toBe('backup');

      const second = await harness.runTurn({
        message: 'and a dessert?',
        steps: [textStep('Poached pears.')],
        expect: { deliveredCount: 1, usedProvider: 'primary', providerCalls: 1 },
      });
      expect(second.failures).toEqual([]);
      // Not sticky: the configured default leads the chain again.
      expect(second.providerCalls[0].provider).toBe('primary');
      expect(harness.providerRegistry.getDefault().name).toBe('primary');
      expect(second.guard.providerNotices).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
