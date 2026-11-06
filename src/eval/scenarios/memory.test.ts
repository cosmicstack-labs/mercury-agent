import { afterAll, describe, expect, it } from 'vitest';
import { runScenario } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';
import { promptText, type ProviderCallRecord } from '../script-player.js';

const TRACE_HEADER = '[Tool activity in my previous turn]';

function expectToolContext(call: ProviderCallRecord, tool: string): void {
  const system = promptText(call.prompt.filter((m) => m.role === 'system'));
  const dialogue = promptText(call.prompt.filter((m) => m.role !== 'system'));
  expect(system).toContain('Historical tool activity');
  expect(system).toContain(tool);
  expect(system).not.toContain(TRACE_HEADER);
  expect(dialogue).not.toContain(TRACE_HEADER);
  expect(dialogue).not.toContain(tool);
}

/**
 * KNOWN REGRESSION (found by this harness, fix belongs in core/agent.ts):
 * the per-turn tool trace (`turnToolTrace`, written at turn end as the
 * `[Tool activity in my previous turn]` session entry) is only fed by
 * `noteToolSteps` in the guard / step-budget / verification continuation
 * rounds. The MAIN loop's `onStepFinish` (streamText and generateText
 * paths) never calls it, so an ordinary tool-using turn leaves no trace and
 * the next turn started blind. Fixed in 1.3.1; the first scenario pins it.
 */
describe('eval · cross-turn memory carries the tool trace', () => {
  afterAll(async () => (await import('../env.js')).removeEvalRoot());

  it('main-loop tool calls are written to the trace the NEXT turn sends to the model', async () => {
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
    expectToolContext(result.turns[1].providerCalls[0], 'create_file path=trip/packing.md');
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
    expectToolContext(second.providerCalls[0], 'run_command command=npm test');
    // Historical reference context, then the previous answer and new question.
    expect(input.indexOf('Historical tool activity')).toBeLessThan(input.indexOf('Verified: npm test passes.'));
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
    expectToolContext(result.turns[0].providerCalls[0], 'read_file path=tsup.config.ts');
  });

  it.each([true, false])('recovers poisoned history and executes a real tool (streaming=%s)', async (streaming) => {
    const imitation = `${TRACE_HEADER}\n- create_file path=imaginary.md → ok`;
    const result = await runScenario({
      name: `memory-poisoned-history-${streaming}`,
      channel: { streaming },
      history: [
        { role: 'user', content: 'read my notes' },
        { role: 'assistant', kind: 'tool-call', content: `${TRACE_HEADER}\n- read_file path=notes.md → ok` },
        { role: 'assistant', content: 'I read notes.md.' },
        { role: 'user', content: 'save a copy' },
        { role: 'assistant', content: imitation },
      ],
      turns: [{
        message: 'save the notes to copy.md',
        steps: [
          toolStep([call('create_file', { path: 'copy.md', content: '# Notes\n' })]),
          textStep('Saved copy.md.'),
        ],
        expect: { deliveredCount: 1, providerCalls: 2, toolsUsed: ['create_file'], finalTextIncludes: ['Saved copy.md.'] },
      }],
    });
    expect(result.failures).toEqual([]);
    const turn = result.turns[0];
    expectToolContext(turn.providerCalls[0], 'read_file path=notes.md');
    for (const call of turn.providerCalls) {
      expect(promptText(call.prompt)).not.toContain('imaginary.md');
    }
    expect(turn.toolCalls[0].recorded).toBe(false);
    expect(JSON.stringify(turn.providerCalls[1].prompt)).toContain('tool-result');
    expect(turn.sessionEntries.find((m) => m.kind === 'tool-call')?.content).toContain('create_file path=copy.md');
  });

  it('keeps a substantive prior answer after a trace-shaped prefix in the actual model input', async () => {
    const diagnosis = 'The actual failure is a missing export. Add parseConfig to index.ts.';
    const content = `${TRACE_HEADER}\n- read_file path=package.json → ok\n\n${diagnosis}`;
    const result = await runScenario({
      name: 'memory-mixed-trace-answer',
      history: [
        { role: 'user', content: 'Why does the build fail?' },
        { role: 'assistant', content },
      ],
      turns: [{ message: 'Which export was missing?', steps: [textStep('parseConfig in index.ts.')], expect: { providerCalls: 1 } }],
    });
    expect(result.failures).toEqual([]);
    const prompt = result.turns[0].providerCalls[0].prompt;
    expect(promptText(prompt.filter((message) => message.role === 'assistant'))).toContain(diagnosis);
    expect(promptText(prompt.filter((message) => message.role === 'system'))).not.toContain('read_file path=package.json');
  });
});
