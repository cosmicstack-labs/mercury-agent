/**
 * Turn-end verdict for the agentic loop.
 *
 * Regression class: the loop ended (stream finished, step budget exhausted,
 * provider dropped) and every ending was celebrated as "Task complete" —
 * including turns that stopped because the tool-step budget ran out
 * mid-implementation, with half the work still on the floor.
 *
 * The verdict answers: WHY did this turn end, and is that ending a
 * legitimate completion?
 *
 *  - 'steps-exhausted' — the loop stopped because the step budget ran out
 *    while the model was still calling tools. That is a PAUSE, not a
 *    completion: the bounded auto-continuation machinery resumes it.
 *  - 'interrupted' / 'truncated' — provider-side failures (see
 *    stream-completion.ts); retry/fallback machinery owns these.
 *  - 'text-stop' — the model chose to stop with a final answer. Whether
 *    that answer may be called "complete" is decided by the execute-mode
 *    verification gate, not here.
 */

import { classifyStreamCompletion, type FinishReasonLike } from './stream-completion.js';

export type LoopEndCause =
  | 'text-stop'
  | 'steps-exhausted'
  | 'interrupted'
  | 'truncated'
  | 'aborted';

export interface TurnEndInput {
  /** Tool steps actually executed this task. */
  stepsUsed: number;
  /** The step budget the loop ran under. */
  maxSteps: number;
  /** The final step ended with tool calls pending (work in progress). */
  lastStepHasToolCalls?: boolean;
  /** The loop was aborted by the user / halt. */
  aborted?: boolean;
  /** Provider finish reason of the final step (stream-completion contract). */
  finishReason?: FinishReasonLike;
}

/**
 * Classify why the agentic loop ended. `finishReason` takes priority (a
 * provider drop or token-cap cut is an interrupted/truncated turn regardless
 * of step counts); the step budget check only fires when the model was still
 * working — a budget reached exactly as the model delivered its final text
 * answer is a legitimate `text-stop`.
 */
export function classifyTurnEnd(input: TurnEndInput): LoopEndCause {
  if (input.aborted) return 'aborted';
  const completion = classifyStreamCompletion({
    finishReason: input.finishReason,
    hasText: true,
    hasToolCalls: input.lastStepHasToolCalls,
  });
  if (completion === 'interrupted') return 'interrupted';
  if (completion === 'truncated') return 'truncated';
  const budgetExhausted = input.maxSteps > 0 && input.stepsUsed >= input.maxSteps;
  if (budgetExhausted && input.lastStepHasToolCalls) return 'steps-exhausted';
  return 'text-stop';
}

/**
 * Continuation nudge injected after a step-budget stop so the loop resumes
 * instead of wrapping a half-done task in a completion banner.
 */
export function stepsExhaustedPrompt(taskHint?: string): string {
  const hint = taskHint?.trim();
  const task = hint ? `The task remains: "${hint.slice(0, 200)}".` : 'The task remains unfinished.';
  return [
    '[SYSTEM: STEP BUDGET] You reached the tool-step budget for this task. The task is NOT done — do not summarize or wrap up.',
    task,
    'Resume exactly where you left off and continue with your tools until the work is finished. Prioritize the remaining steps; skip re-doing work already completed.',
  ].join(' ');
}

/** Banner label for a turn that paused at the step budget. */
export const STEPS_PAUSED_BANNER = 'Task paused · step budget reached — send "continue" to resume';

/** Banner label when a response was delivered but nothing changed in the world. */
export const NO_CHANGES_BANNER = 'Response delivered · no file changes';