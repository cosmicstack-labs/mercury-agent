import { afterAll, describe, expect, it } from 'vitest';
import { EvalHarness, runScenario } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';

describe('eval · /trace', () => {
  afterAll(async () => (await import('../env.js')).removeEvalRoot());

  const listTurn = {
    message: 'list what is in my downloads folder',
    steps: [
      toolStep([call('list_dir', { path: 'downloads' }, 'file: report.pdf\nfile: photo.jpg')], undefined, { inputTokens: 700, outputTokens: 20 }),
      textStep('Two files: report.pdf and photo.jpg.', { inputTokens: 800, outputTokens: 30, cachedInputTokens: 600 }),
    ],
    expect: { deliveredCount: 1, toolsUsed: ['list_dir'] },
  };

  it('/trace after a turn reports provider, tokens and steps — answered by the agent, not the model', async () => {
    const result = await runScenario({
      name: 'trace-after-turn',
      turns: [listTurn, { message: '/trace', expect: { deliveredCount: 1, providerCalls: 0 } }],
    });
    expect(result.failures).toEqual([]);
    const [turn, trace] = result.turns;
    expect(trace.finalText).toMatch(new RegExp(`^Trace ${turn.traceId}`));
    expect(trace.finalText).toContain('Provider: scripted / scripted-model');
    expect(trace.finalText).toMatch(/Tokens: \d+ in \(\d+ cached\) · \d+ out/);
    expect(trace.finalText).toContain('Steps: 2');
    expect(trace.finalText).toContain('Verification: none');
  });

  // KNOWN REGRESSION: main-loop tool calls never reach the turn trace (see
  // memory.test.ts) — /trace prints "No tool calls in this turn." here.
  it.fails('/trace lists the main loop\'s tool calls', async () => {
    const result = await runScenario({ name: 'trace-tool-lines', turns: [listTurn, { message: '/trace' }] });
    expect(result.turns[1].finalText).toContain('- list_dir path=downloads');
  });

  it('/trace <id> resolves the id printed on a terminal message, with verification and tool lines', async () => {
    const harness = await EvalHarness.create({
      name: 'trace-by-id',
      programmingMode: 'execute',
      channel: { streaming: false },
      turns: [],
    });
    try {
      const work = await harness.runTurn({
        message: 'fix the failing add() test in src/math.ts',
        steps: [
          toolStep([call('edit_file', { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' }, 'Successfully edited src/math.ts')]),
          textStep('Fixed the sign.'),
          toolStep([call('run_command', { command: 'npm test' }, 'Tests  3 passed (3)')]),
          textStep('Verified: npm test passes.'),
        ],
        expect: { verificationRounds: 1, finalTextIncludes: ['npm test ✓', '/trace '] },
      });
      expect(work.failures).toEqual([]);
      expect(work.finalText).toContain(`/trace ${work.traceId}`);
      // An unrelated turn in between: /trace <id> must still find the first one.
      await harness.runTurn({ message: 'thanks', steps: [textStep('Any time.')] });

      const trace = await harness.runTurn({ message: `/trace ${work.traceId}`, expect: { deliveredCount: 1, providerCalls: 0 } });
      expect(trace.failures).toEqual([]);
      expect(trace.finalText).toMatch(new RegExp(`^Trace ${work.traceId}`));
      expect(trace.finalText).toContain('Verification: npm test ✓');
      expect(trace.finalText).toContain('- run_command command=npm test');
      expect(trace.finalText).toMatch(/Steps: \d+/);
    } finally {
      await harness.dispose();
    }
  });
});
