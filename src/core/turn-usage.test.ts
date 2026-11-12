import { describe, expect, it } from 'vitest';
import { TurnUsage, billingEntries } from './turn-usage.js';

// The per-step input figures from the 4-step gateway probe in the bug report:
// the SDK's result.usage returned only the last (574); the turn spent 1,902.
const probeSteps = [
  { inputTokens: 351, outputTokens: 60, inputTokenDetails: { cacheReadTokens: 0, noCacheTokens: 351 } },
  { inputTokens: 460, outputTokens: 50, inputTokenDetails: { cacheReadTokens: 300, noCacheTokens: 160 } },
  { inputTokens: 517, outputTokens: 53, inputTokenDetails: { cacheReadTokens: 450, noCacheTokens: 67 } },
  { inputTokens: 574, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 500, noCacheTokens: 74 } },
];

describe('TurnUsage', () => {
  it('sums every step, not just the last one', () => {
    const u = new TurnUsage();
    for (const step of probeSteps) u.add(step);
    const t = u.totals();
    expect(t.inputTokens).toBe(1902);
    expect(t.outputTokens).toBe(165);
    expect(t.totalTokens).toBe(2067);
    expect(t.steps).toBe(4);
  });

  it('splits input into cache hits and uncached', () => {
    const u = new TurnUsage();
    for (const step of probeSteps) u.add(step);
    const t = u.totals();
    expect(t.cachedInputTokens).toBe(1250);
    expect(t.noCacheInputTokens).toBe(652);
    expect(t.cachedInputTokens + t.noCacheInputTokens).toBe(t.inputTokens);
  });

  it('keeps counting across rounds, including rounds that return no text', () => {
    // Main loop, then a tool-only guard round, then a verification round:
    // the old code kept only the newest round with text.
    const u = new TurnUsage();
    u.add({ inputTokens: 1000, outputTokens: 10 }); // main loop
    u.add({ inputTokens: 1200, outputTokens: 0 }); // guard, tool call only
    u.add({ inputTokens: 1300, outputTokens: 40 }); // verification
    expect(u.totals()).toMatchObject({ inputTokens: 3500, outputTokens: 50, steps: 3 });
  });

  it('keeps steps already counted when a later step never arrives', () => {
    // A stream that errors after two steps: step callbacks have fired for
    // both, so they stay counted even though totalUsage would reject.
    const u = new TurnUsage();
    u.add({ inputTokens: 400, outputTokens: 5 });
    u.add({ inputTokens: 450, outputTokens: 7 });
    expect(u.totals()).toMatchObject({ inputTokens: 850, outputTokens: 12, steps: 2 });
  });

  it('falls back to deprecated fields and derives uncached input', () => {
    const u = new TurnUsage();
    u.add({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, reasoningTokens: 5 });
    expect(u.totals()).toMatchObject({ cachedInputTokens: 80, noCacheInputTokens: 20, reasoningTokens: 5 });
  });

  it('treats missing or malformed usage as zero', () => {
    const u = new TurnUsage();
    u.add(undefined);
    u.add(null);
    u.add({ inputTokens: Number.NaN, outputTokens: -3 });
    u.add({});
    const t = u.totals();
    expect(t).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, noCacheInputTokens: 0, totalTokens: 0 });
    expect(t.steps).toBe(2);
  });
});

describe('per-provider billing', () => {
  const primary = { name: 'anthropic', model: 'claude-sonnet' };
  const fallback = { name: 'openai', model: 'gpt-5' };

  it('bills steps from a provider that failed before a fallback to that provider', () => {
    // The primary finishes two tool steps, then errors; the fallback
    // provider runs the turn to completion in three steps.
    const u = new TurnUsage();
    u.add({ inputTokens: 1000, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 800, noCacheTokens: 200 } }, primary);
    u.add({ inputTokens: 1100, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 900, noCacheTokens: 200 } }, primary);
    u.add({ inputTokens: 1500, outputTokens: 40 }, fallback);
    u.add({ inputTokens: 1600, outputTokens: 50 }, fallback);
    u.add({ inputTokens: 1700, outputTokens: 60 }, fallback);

    const entries = billingEntries(u.totals(), u.bySource(), fallback);
    expect(entries).toEqual([
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet', inputTokens: 2100, cachedInputTokens: 1700, noCacheInputTokens: 400, outputTokens: 50, steps: 2 }),
      expect.objectContaining({ provider: 'openai', model: 'gpt-5', inputTokens: 4800, cachedInputTokens: 0, outputTokens: 150, steps: 3 }),
    ]);
  });

  it('keeps one entry for a turn served by a single provider', () => {
    const u = new TurnUsage();
    for (const step of probeSteps) u.add(step, primary);
    const entries = billingEntries(u.totals(), u.bySource(), primary);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: 'anthropic', inputTokens: 1902, outputTokens: 165, steps: 4 });
  });

  it('separates two models of the same provider', () => {
    const u = new TurnUsage();
    u.add({ inputTokens: 100, outputTokens: 1 }, { name: 'openai', model: 'a' });
    u.add({ inputTokens: 200, outputTokens: 2 }, { name: 'openai', model: 'b' });
    expect(u.bySource().map((s) => [s.model, s.inputTokens])).toEqual([['a', 100], ['b', 200]]);
  });

  it('bills untagged usage to the fallback, and entries always sum to the turn', () => {
    const u = new TurnUsage();
    u.add({ inputTokens: 300, outputTokens: 3 }, primary);
    u.add({ inputTokens: 400, outputTokens: 4 });
    const entries = billingEntries(u.totals(), u.bySource(), fallback);
    expect(entries.map((e) => [e.provider, e.inputTokens, e.outputTokens])).toEqual([['anthropic', 300, 3], ['openai', 400, 4]]);
    const sum = entries.reduce((n, e) => n + e.totalTokens, 0);
    expect(sum).toBe(u.totals().totalTokens);
  });

  it('falls back to a single entry when no step reported usage', () => {
    // The no-step-callback path: totals come from result.usage instead.
    const fromResult = new TurnUsage();
    fromResult.add({ inputTokens: 500, outputTokens: 5 });
    expect(billingEntries(fromResult.totals(), [], primary)).toEqual([
      expect.objectContaining({ provider: 'anthropic', inputTokens: 500, outputTokens: 5 }),
    ]);
    expect(billingEntries(fromResult.totals(), [], null)[0]).toMatchObject({ provider: 'unknown', model: 'unknown' });
  });
});
