import { afterAll, describe, expect, it } from 'vitest';
import { runScenario } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';
import { promptText } from '../script-player.js';

const TRACE_HEADER = '[Tool activity in my previous turn]';

/**
 * KNOWN REGRESSION (found by this harness, fix belongs in core/agent.ts):
 * the per-turn tool trace (`turnToolTrace`, written at turn end as the
 * `[Tool activity in my previous turn]` session entry) is only fed by
 * `noteToolSteps` in the guard / step-budget / verification continuation
 * rounds. The MAIN loop's `onStepFinish` (streamText and generateText
 * paths) never calls it, so an ordinary tool-using turn leaves no trace and
 * the next turn starts blind. The first scenario is `it.fails` until that
 * call is added; the read side is pinned by the passing scenarios.
 */
describe('eval · cross-turn memory carries the tool trace', () => {
  afterAll(async () => (await import('../env.js')).removeEvalRoot());

  it.fails('main-loop tool calls are written to the trace the NEXT turn sends to the model', async () => {
    const result = await runScenario({
      name: 'memory-main-loop-trace',
      turns: [
        {
          message: 'save a packing list for my trip',
          steps: [
            toolStep([call('create_file', { path: 'trip/packing.md', content: '- passport\n- charger\n' }, 'Created trip/packing.md')]),
            textStep('Saved your packing list to trip/packing.md.'),
          ],
          expect: { deliveredCount: 1, toolsUsed: ['create_file'] },
        },
        { message: 'which file did you put it in?', steps: [textStep('It is in trip/packing.md.')], expect: { deliveredCount: 1, providerCalls: 1 } },
      ],
    });
    expect(result.failures).toEqual([]);
    const input = promptText(result.turns[1].providerCalls[0].prompt);
    expect(input).toContain(TRACE_HEADER);
    expect(input).toContain('create_file path=trip/packing.md');
  });

  it('a trace written during a turn (verification round) reaches the next turn\'s model input', async () => {
    const result = await runScenario({
      name: 'memory-continuation-trace',
      programmingMode: 'execute',
      channel: { streaming: false },
      turns: [
        {
          message: 'fix the failing add() test in src/math.ts',
          steps: [
            toolStep([call('edit_file', { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' }, 'Successfully edited src/math.ts')]),
            textStep('Fixed the sign.'),
            // forced verification round (its tool steps ARE traced)
            toolStep([call('run_command', { command: 'npm test' }, 'Tests  3 passed (3)')]),
            textStep('Verified: npm test passes.'),
          ],
          expect: { verificationRounds: 1, pause: null },
        },
        { message: 'what did you run to check it?', steps: [textStep('npm test.')], expect: { deliveredCount: 1, providerCalls: 1 } },
      ],
    });
    expect(result.failures).toEqual([]);
    const [first, second] = result.turns;
    const trace = first.sessionEntries.find((m) => m.kind === 'tool-call');
    expect(trace?.content.startsWith(TRACE_HEADER)).toBe(true);
    expect(trace?.content).toContain('run_command command=npm test');

    const input = promptText(second.providerCalls[0].prompt);
    expect(input).toContain(TRACE_HEADER);
    expect(input).toContain('run_command command=npm test');
    // Trace, then the previous answer, then the new question.
    expect(input.indexOf(TRACE_HEADER)).toBeLessThan(input.indexOf('Verified: npm test passes.'));
    expect(input.indexOf('Verified: npm test passes.')).toBeLessThan(input.indexOf('what did you run to check it?'));
  });

  it('a seeded session with a prior tool trace reaches the model input', async () => {
    const result = await runScenario({
      name: 'memory-seeded-trace',
      history: [
        { role: 'user', content: 'check the build config' },
        { role: 'assistant', kind: 'tool-call', content: `${TRACE_HEADER}\n- read_file path=tsup.config.ts → ok (24 lines)` },
        { role: 'assistant', content: 'The build targets node20 with ESM output.' },
      ],
      turns: [{ message: 'and the entry point?', steps: [textStep('src/index.ts.')], expect: { deliveredCount: 1 } }],
    });
    expect(result.failures).toEqual([]);
    const input = promptText(result.turns[0].providerCalls[0].prompt);
    expect(input).toContain(`${TRACE_HEADER}\n- read_file path=tsup.config.ts`);
  });
});
