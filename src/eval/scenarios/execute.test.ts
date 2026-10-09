import { afterAll, describe, expect, it } from 'vitest';
import { runScenario } from '../runner.js';
import { call, textStep, toolStep, type ScriptedStep } from '../fixture.js';
import { STEPS_PAUSED_BANNER, VERIFICATION_FAILED_BANNER } from '../../core/completion-verdict.js';

const TASK = 'fix the failing add() test in src/math.ts';
const edit = call('edit_file', { path: 'src/math.ts', old_string: 'return a - b;', new_string: 'return a + b;' }, 'Successfully edited src/math.ts (1 replacement)');
const failingTest = call('run_command', { command: 'npm test' }, 'Command exited with code 1\n\nFAIL src/math.test.ts > add > adds two numbers\nAssertionError: expected -1 to be 3');
const passingTest = call('run_command', { command: 'npm test' }, '> vitest run\n\n ✓ src/math.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)');

/**
 * KNOWN REGRESSION (found by this harness, fix belongs in core/agent.ts):
 * on the STREAMING path handleMessage stores `result = { text, usage,
 * reasoning }` without `finishReason`, so `classifyTurnEnd` reads
 * `undefined` → 'interrupted' for every streamed turn. The verification gate
 * (`turnEnd() === 'text-stop'`) and step-budget continuation/pause
 * (`'steps-exhausted'`) are therefore dead on every streaming channel (CLI,
 * web, Telegram/Discord/Slack with streaming on, Signal). The scenarios below
 * (Fixed in 1.3.1: finishReason is carried on every result.) Both delivery
 * paths are pinned below so the regression cannot return.
 */
const PATHS = [
  { label: 'non-streaming', streaming: false, gateWorks: true },
  { label: 'streaming', streaming: true, gateWorks: true },
] as const;

afterAll(async () => (await import('../env.js')).removeEvalRoot());

describe.each(PATHS)('eval · execute mode completion contract ($label delivery)', ({ label, streaming, gateWorks }) => {
  const itGate = gateWorks ? it : it.fails;

  const verifyFail = () => runScenario({
      name: `execute-verify-fail-${label}`,
      channel: { streaming },
      programmingMode: 'execute',
      turns: [{
        message: TASK,
        steps: [
          toolStep([edit]),
          toolStep([failingTest]),
          textStep('I fixed the sign in add().'),
          // The verification gate forces exactly one evidence round
          // (toolChoice: required); it fails again.
          toolStep([failingTest]),
          textStep('The test still fails.'),
        ],
        expect: {
          pause: 'verification-failed',
          forcedActionRounds: 0,
          toolsUsed: ['edit_file', 'run_command'],
          noEventIncludes: ['Task complete'],
          anyEventIncludes: [VERIFICATION_FAILED_BANNER, 'npm test ✗'],
        },
      }],
    });

  it('edit → FAILING npm test → text: pauses with the verification-failed banner, never "Task complete"', async () => {
    const result = await verifyFail();
    // The script carries a step for the forced evidence round; the
    // streaming path never takes it (see KNOWN REGRESSION above).
    const failures = gateWorks ? result.failures : result.failures.filter((f) => !f.includes('more model calls'));
    expect(failures).toEqual([]);
    const [turn] = result.turns;
    expect(turn.finalText).toContain(VERIFICATION_FAILED_BANNER);
    expect(turn.finalText).toMatch(/\/trace [a-z0-9]+/i);
    expect(turn.events.some((e) => e.kind === 'completion')).toBe(false);
    // A pause is not a completed answer: no assistant message is stored.
    expect(turn.sessionEntries.some((m) => m.role === 'assistant' && m.kind === 'message')).toBe(false);
    expect(turn.timings.steps.length).toBe(turn.providerCalls.length);
    expect(turn.timings.promptBuildMs).toBeGreaterThan(0);
  });

  itGate('the verification gate forces exactly one evidence round (toolChoice: required)', async () => {
    const [turn] = (await verifyFail()).turns;
    expect(turn.guard.verificationRounds).toBe(1);
    expect(turn.guard.forcedToolChoiceCalls).toBe(1);
    expect(turn.providerCalls).toHaveLength(5);
    expect(turn.notices.some((n) => n.includes('Checking my work'))).toBe(true);
  });

  it('edit → passing npm test → completes with a ✓ verification note and a /trace id', async () => {
    const result = await runScenario({
      name: `execute-verify-pass-${label}`,
      channel: { streaming },
      programmingMode: 'execute',
      turns: [{
        message: TASK,
        steps: [toolStep([edit]), toolStep([passingTest]), textStep('Fixed add(): it now returns a + b. All 3 tests pass.')],
        expect: {
          deliveredCount: 1,
          pause: null,
          verificationRounds: 0,
          forcedActionRounds: 0,
          providerCalls: 3,
          finalTextIncludes: ['Fixed add()', 'npm test ✓', '/trace '],
        },
      }],
    });
    expect(result.failures).toEqual([]);
    const [turn] = result.turns;
    expect(turn.traceId).toBeTruthy();
    expect(turn.finalText).toContain(`/trace ${turn.traceId}`);
    const answer = turn.sessionEntries.find((m) => m.role === 'assistant' && m.kind === 'message');
    expect(answer?.metadata).toMatchObject({ verification: 'npm test ✓', steps: 3, provider: 'scripted' });
    expect(turn.events.some((e) => e.kind === 'completion')).toBe(false); // short task: footer, no banner
    expect(turn.timings.steps.map((s) => s.durationMs).every((d) => d >= 0)).toBe(true);
    expect(turn.timings.deliveryMs).toBeGreaterThanOrEqual(0);
  });

  itGate('step budget exhausted → honest pause banner, delivered as a persistent message (not a status-card notice)', async () => {
    let n = 0;
    const endless = (): ScriptedStep => {
      n++;
      return toolStep([call('create_file', { path: `gen/part-${n}.ts`, content: `export const part${n} = ${n};\n` }, `Created gen/part-${n}.ts`)]);
    };
    const result = await runScenario({
      name: `execute-steps-exhausted-${label}`,
      channel: { streaming },
      programmingMode: 'execute',
      turns: [{ message: 'build the generator module', onExhausted: endless, expect: { pause: 'steps', forcedActionRounds: 0, noEventIncludes: ['Task complete'] } }],
    });
    expect(result.failures).toEqual([]);
    const [turn] = result.turns;
    // Bounded automatic continuations happened before the pause.
    expect(turn.guard.stepBudgetContinuations).toBe(6); // MAX_AUTOMATIC_CONTINUATIONS
    expect(turn.delivered.some((t) => t.includes('(no text response)'))).toBe(false);
    const banner = turn.events.find((e) => e.text.includes(STEPS_PAUSED_BANNER));
    expect(banner?.kind).toBe('delivered');
    expect(turn.notices.some((t) => t.includes(STEPS_PAUSED_BANNER))).toBe(false);
    // The task was ended BEFORE the banner was sent, so it is not swallowed by the status card.
    const end = turn.events.findIndex((e) => e.kind === 'task-end');
    expect(end).toBeGreaterThanOrEqual(0);
    expect(turn.events.indexOf(banner!)).toBeGreaterThan(end);
    expect(turn.finalText).toContain(STEPS_PAUSED_BANNER);
    expect(turn.timings.steps.length).toBe(turn.providerCalls.length);
  });
});
