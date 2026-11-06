/**
 * Turn-scoped token accounting.
 *
 * One agent turn makes many model calls: tool steps in the main loop, then
 * truncation continuations, the guard round, step-budget continuations and
 * verification. The SDK's `result.usage` is the LAST step only (ai@6:
 * "The token usage of the last step"), and each later round replaced
 * `result`, so the turn used to report a single step's tokens.
 *
 * The fix is to add every step's own usage here, from the step callbacks
 * (`onStepFinish`). A step callback fires for every step that finished, so a
 * stream that later errors, aborts or falls back to another provider still
 * has its billed steps counted — `totalUsage` would reject in those cases.
 */

/** The subset of the SDK's `LanguageModelUsage` this module reads. */
export interface StepUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
  /** @deprecated in ai@6 — read as a fallback for cache hits. */
  cachedInputTokens?: number;
  /** @deprecated in ai@6 — read as a fallback for reasoning tokens. */
  reasoningTokens?: number;
}

export interface TurnUsageTotals {
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Input tokens billed at the full rate (input minus cache hits). */
  noCacheInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Number of steps whose usage was added. */
  steps: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export class TurnUsage {
  private input = 0;
  private cached = 0;
  private noCache = 0;
  private output = 0;
  private reasoning = 0;
  private stepCount = 0;

  /** Add one step's usage. Missing or malformed fields count as 0. */
  add(usage: StepUsageLike | null | undefined): void {
    if (!usage || typeof usage !== 'object') return;
    const input = count(usage.inputTokens);
    const cached = count(usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens);
    const noCacheReported = usage.inputTokenDetails?.noCacheTokens;
    const noCache = typeof noCacheReported === 'number'
      ? count(noCacheReported)
      : Math.max(0, input - cached);
    this.input += input;
    this.cached += cached;
    this.noCache += noCache;
    this.output += count(usage.outputTokens);
    this.reasoning += count(usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens);
    this.stepCount++;
  }

  totals(): TurnUsageTotals {
    return {
      inputTokens: this.input,
      cachedInputTokens: this.cached,
      noCacheInputTokens: this.noCache,
      outputTokens: this.output,
      reasoningTokens: this.reasoning,
      totalTokens: this.input + this.output,
      steps: this.stepCount,
    };
  }
}
