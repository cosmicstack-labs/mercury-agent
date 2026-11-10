import { afterAll, describe, expect, it } from 'vitest';
import { EvalHarness, runScenario } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';

/**
 * #296 on the real agent: a turn bills every model step it made (ai@6's
 * result.usage is the last step only), and a turn that ends early — here
 * a provider failing after a tool ran — still bills the steps it spent.
 */
describe('eval · token usage counts every step (#296)', () => {
  afterAll(async () => {
    const { removeEvalRoot } = await import('../env.js');
    removeEvalRoot();
  });

  it('a two-step turn reports and bills both steps', async () => {
    const result = await runScenario({
      name: 'usage-two-steps',
      turns: [{
        message: 'write my notes to notes.md',
        steps: [
          toolStep([call('create_file', { path: 'notes.md', content: '- milk\n' })], undefined, { inputTokens: 1000, outputTokens: 50 }),
          textStep('Saved to notes.md.', { inputTokens: 2000, outputTokens: 80 }),
        ],
      }],
    });
    expect(result.failures).toEqual([]);
    // The old code reported the last step only: 2000 / 80.
    expect(result.turns[0].tokens).toMatchObject({ input: 3000, output: 130 });
  });

  it('a turn that ends early still bills the steps it ran', async () => {
    const harness = await EvalHarness.create({
      name: 'usage-early-exit',
      providers: [{ name: 'scripted', failOnCalls: [2] }],
      turns: [],
    });
    try {
      const before = harness.agent.tokenBudget.getDailyUsed();
      await harness.runTurn({
        message: 'write my notes to notes.md',
        steps: [toolStep([call('create_file', { path: 'notes.md', content: '- milk\n' })], undefined, { inputTokens: 1000, outputTokens: 50 })],
      });
      // Step 1 ran (and its tool), step 2's call failed: the turn ended on the
      // failure path, which used to record nothing.
      expect(harness.agent.tokenBudget.getDailyUsed() - before).toBe(1050);
    } finally {
      await harness.dispose();
    }
  });
});
