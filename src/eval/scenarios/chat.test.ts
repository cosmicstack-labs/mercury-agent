import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, type TurnResult } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';

const NO_GUARD_TEXT = [
  'getting started on the real build',
  "couldn't get started",
  'Checking my work before I call it done',
  'Taking a completely different run',
];

function expectTimings(turn: TurnResult): void {
  expect(turn.timings.steps.length).toBe(turn.providerCalls.length);
  expect(turn.timings.promptBuildMs).toBeGreaterThan(0);
  for (const step of turn.timings.steps) {
    expect(step.startMs).toBeGreaterThan(0);
    expect(step.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(turn.timings.deliveryMs).toBeGreaterThanOrEqual(0);
  expect(turn.timings.totalMs).toBeGreaterThanOrEqual(turn.timings.promptBuildMs);
}

describe('eval · chat mode never forces guard rounds', () => {
  afterAll(async () => {
    const { removeEvalRoot } = await import('../env.js');
    removeEvalRoot();
  });

  it('"make me a workout plan" → one delivered answer, zero forced rounds', async () => {
    const plan = 'Here is a 3-day plan:\n- Day 1: squats, push-ups\n- Day 2: rest and a 30 minute walk\n- Day 3: deadlifts, rows, planks';
    const result = await runScenario({
      name: 'chat-workout-plan',
      turns: [{
        message: 'make me a workout plan',
        steps: [textStep(plan, { inputTokens: 900, outputTokens: 60 })],
        expect: {
          deliveredCount: 1,
          finalTextIncludes: ['3-day plan'],
          providerCalls: 1,
          forcedActionRounds: 0,
          verificationRounds: 0,
          pause: null,
          noEventIncludes: NO_GUARD_TEXT,
        },
      }],
    });
    expect(result.failures).toEqual([]);
    const [turn] = result.turns;
    expect(turn.guard.forcedToolChoiceCalls).toBe(0);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.tokens).toMatchObject({ input: 900, output: 60 });
    expect(turn.usedProvider).toBe('scripted');
    // user message + assistant answer, no tool trace for a tool-free turn
    expect(turn.sessionEntries.map((m) => `${m.role}:${m.kind}`)).toEqual(['user:message', 'assistant:message']);
    expectTimings(turn);
  });

  it('"write my notes to notes.md" → real create_file runs, answer delivered, no verification nudge', async () => {
    const result = await runScenario({
      name: 'chat-write-notes',
      turns: [{
        message: 'write my notes to notes.md',
        steps: [
          toolStep([call('create_file', { path: 'notes.md', content: '# Notes\n- buy milk\n' })]),
          textStep('Saved your notes to notes.md.'),
        ],
        expect: {
          deliveredCount: 1,
          finalTextIncludes: ['notes.md'],
          providerCalls: 2,
          forcedActionRounds: 0,
          verificationRounds: 0,
          pause: null,
          toolsUsed: ['create_file'],
          noEventIncludes: NO_GUARD_TEXT,
        },
      }],
    });
    expect(result.failures).toEqual([]);
    const [turn] = result.turns;
    expect(turn.toolCalls[0].recorded).toBe(false);
    expect(readFileSync(join(result.workDir, 'notes.md'), 'utf8')).toContain('buy milk');
    expect(existsSync(join(result.workDir, 'notes.md'))).toBe(true);
    // The tool result went back to the model on the second call.
    expect(JSON.stringify(turn.providerCalls[1].prompt)).toContain('tool-result');
    expectTimings(turn);
  });
});
