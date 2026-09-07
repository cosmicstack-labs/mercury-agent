/**
 * Stream completion integrity.
 *
 * When a provider connection drops mid-generation (auth failure, network cut,
 * server crash) the AI SDK emits no terminal `finish` chunk. The per-step
 * finishReason then stays at its default — 'other'. Treating that as success
 * produced "Task complete" banners after silent mid-sentence cut-offs: the
 * task never continued, and the work ledger even marked the task complete.
 *
 * Rules:
 *  - 'error'  → always a failure.
 *  - 'other'  → a stream that ended WITHOUT a provider finish signal.
 *               A clean generation always reports stop/length/tool-calls/
 *               content-filter. 'other' on a task with required output
 *               (tools or streaming) is treated as an interrupted stream
 *               so Mercury's retry/fallback machinery engages.
 *  - 'stop'/'tool-calls'/'length'/'content-filter' → legitimate ends.
 */

export type FinishReasonLike = string | undefined | null;

export type StreamCompletionVerdict = 'complete' | 'truncated' | 'interrupted';

export interface StreamCompletionInput {
  finishReason: FinishReasonLike;
  hasText: boolean;
  hasToolCalls?: boolean;
}

export function classifyStreamCompletion(input: StreamCompletionInput): StreamCompletionVerdict {
  switch (input.finishReason) {
    case 'stop':
    case 'tool-calls':
    case 'content-filter':
      return 'complete';
    case 'length':
      return 'truncated';
    case 'error':
      return 'interrupted';
    case 'other':
    case 'unknown':
    case undefined:
    case null:
      // A provider drop mid-stream produces no finish chunk at all.
      // Distinguish: any tool activity or visible text means the generation
      // started and was severed — interrupted. Truly empty output is also
      // not a success; it is interrupted too (nothing to deliver).
      return 'interrupted';
    default:
      return 'interrupted';
  }
}

/** True when this finish reason means the model hit its output-token cap. */
export function isLengthTruncation(finishReason: FinishReasonLike): boolean {
  return finishReason === 'length';
}

/**
 * Build a continuation nudge appended after a truncated (length) response so
 * an agentic loop resumes instead of stopping mid-implementation.
 */
export function truncationContinuationPrompt(taskHint: string | undefined): string {
  const hint = taskHint?.trim();
  return hint
    ? `[SYSTEM] Your previous response hit the output-token limit and was cut off. Continue exactly where you left off for the task: "${hint.slice(0, 200)}". Do not repeat completed work; resume from the cut point and finish the remaining implementation.`
    : '[SYSTEM] Your previous response hit the output-token limit and was cut off. Continue exactly where you left off. Do not repeat completed work; resume from the cut point and finish the remaining implementation.';
}