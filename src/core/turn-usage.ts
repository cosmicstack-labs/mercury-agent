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

/** The provider and model a step was sent to. */
export interface UsageSource {
  name: string;
  model: string;
}

export interface SourceUsageTotals extends TurnUsageTotals {
  provider: string;
  model: string;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export class TurnUsage {
  private input = 0;
  private cached = 0;
  private noCache = 0;
  private output = 0;
  private reasoning = 0;
  private stepCount = 0;
  /** Per provider+model, so a fallback turn bills each provider its own steps. */
  private readonly sources = new Map<string, { source: UsageSource; usage: TurnUsage }>();

  /**
   * Add one step's usage. Missing or malformed fields count as 0. `source`
   * is the provider the step was sent to; steps without one count toward
   * the turn total only.
   */
  add(usage: StepUsageLike | null | undefined, source?: UsageSource | null): void {
    if (!usage || typeof usage !== 'object') return;
    if (source) {
      const key = `${source.name}\u0000${source.model}`;
      let bucket = this.sources.get(key);
      if (!bucket) {
        bucket = { source: { name: source.name, model: source.model }, usage: new TurnUsage() };
        this.sources.set(key, bucket);
      }
      bucket.usage.add(usage);
    }
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

  /** Totals per provider+model, in the order each was first used. */
  bySource(): SourceUsageTotals[] {
    return [...this.sources.values()].map(({ source, usage }) => ({
      provider: source.name,
      model: source.model,
      ...usage.totals(),
    }));
  }
}

/**
 * The budget entries for one turn: one per provider+model that ran steps,
 * so a turn that fell back bills the failed provider for its finished steps
 * and the fallback for the rest. Usage not tagged with a provider (or a
 * turn whose totals came from somewhere other than step callbacks) goes to
 * `fallback`. The entries always add up to `totals`.
 */
export function billingEntries(
  totals: TurnUsageTotals,
  sources: SourceUsageTotals[],
  fallback: UsageSource | null,
): SourceUsageTotals[] {
  const rest: SourceUsageTotals = {
    provider: fallback?.name ?? 'unknown',
    model: fallback?.model ?? 'unknown',
    ...totals,
  };
  for (const s of sources) {
    rest.inputTokens -= s.inputTokens;
    rest.cachedInputTokens -= s.cachedInputTokens;
    rest.noCacheInputTokens -= s.noCacheInputTokens;
    rest.outputTokens -= s.outputTokens;
    rest.reasoningTokens -= s.reasoningTokens;
    rest.totalTokens -= s.totalTokens;
    rest.steps -= s.steps;
  }
  if (sources.length > 0 && rest.totalTokens <= 0) return sources;
  return [...sources, rest];
}
