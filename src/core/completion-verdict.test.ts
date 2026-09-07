import { describe, expect, it } from 'vitest';
import {
  classifyTurnEnd,
  stepsExhaustedPrompt,
  STEPS_PAUSED_BANNER,
  NO_CHANGES_BANNER,
} from './completion-verdict.js';

describe('classifyTurnEnd', () => {
  it('reports steps-exhausted when the budget ran out mid-tool-work', () => {
    const verdict = classifyTurnEnd({
      stepsUsed: 75,
      maxSteps: 75,
      lastStepHasToolCalls: true,
      finishReason: 'tool-calls',
    });
    expect(verdict).toBe('steps-exhausted');
  });

  it('treats a budget reached exactly at the final text answer as text-stop', () => {
    // The model delivered its final response on the last allowed step —
    // budget and end coincide, but the work concluded on its own.
    const verdict = classifyTurnEnd({
      stepsUsed: 75,
      maxSteps: 75,
      lastStepHasToolCalls: false,
      finishReason: 'stop',
    });
    expect(verdict).toBe('text-stop');
  });

  it('never reports steps-exhausted below the budget', () => {
    const verdict = classifyTurnEnd({
      stepsUsed: 12,
      maxSteps: 75,
      lastStepHasToolCalls: true,
      finishReason: 'tool-calls',
    });
    expect(verdict).toBe('text-stop');
  });

  it('aborts take priority over everything', () => {
    expect(classifyTurnEnd({ stepsUsed: 75, maxSteps: 75, lastStepHasToolCalls: true, aborted: true })).toBe('aborted');
  });

  it('provider interruptions and token-cap cuts are never completions', () => {
    expect(
      classifyTurnEnd({ stepsUsed: 3, maxSteps: 75, lastStepHasToolCalls: true, finishReason: 'other' }),
    ).toBe('interrupted');
    expect(
      classifyTurnEnd({ stepsUsed: 75, maxSteps: 75, lastStepHasToolCalls: false, finishReason: 'length' }),
    ).toBe('truncated');
    expect(
      classifyTurnEnd({ stepsUsed: 75, maxSteps: 75, lastStepHasToolCalls: true, finishReason: 'error' }),
    ).toBe('interrupted');
  });
});

describe('stepsExhaustedPrompt', () => {
  it('states the task is not done and includes the hint', () => {
    const prompt = stepsExhaustedPrompt('Build the dashboard widget');
    expect(prompt).toContain('NOT done');
    expect(prompt).toContain('Build the dashboard widget');
  });

  it('works without a hint', () => {
    expect(stepsExhaustedPrompt()).toContain('NOT done');
  });
});

describe('honest banner labels', () => {
  it('paused banner tells the user the task is not complete', () => {
    expect(STEPS_PAUSED_BANNER).toContain('paused');
    expect(STEPS_PAUSED_BANNER).not.toContain('Task complete');
  });

  it('no-changes banner does not claim completion', () => {
    expect(NO_CHANGES_BANNER).not.toContain('Task complete');
  });
});