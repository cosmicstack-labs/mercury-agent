const MB = 1024 * 1024;

/**
 * Step-level memory governor for agent loops.
 *
 * The wall-clock memory guard (setInterval) cannot fire while the event loop
 * is blocked (stream floods, big tool executions). This governor runs at
 * deterministic points — between AI SDK steps — so growth is checked at
 * every tool-step boundary regardless of event loop pressure.
 *
 * Graduated response (per task):
 *   ok       → no action
 *   relief   → trim conversation budget (oldest tool results)
 *   abort    → abort the current generation; the task fails gracefully
 *   exit     → the allocator is beyond abort reach; exit while state persists
 */
export type MemoryGovernorVerdict = 'ok' | 'relief' | 'abort' | 'exit';

export interface MemoryGovernorThresholds {
  /** heapUsed above this triggers conversation relief (trim old tool results). */
  reliefBytes: number;
  /** heapUsed above this aborts the current generation. */
  abortBytes: number;
  /** heapUsed above this exits the process while persistence is still possible. */
  exitBytes: number;
}

export interface MemoryGovernorDeps {
  heapSizeLimit: number;
  baselineHeapUsed: number;
  /** Minimum heap the process needs to survive (persist, render, respond). */
  reservedHeapBytes?: number;
}

export function memoryGovernorThresholds(deps: MemoryGovernorDeps): MemoryGovernorThresholds {
  const reserve = deps.reservedHeapBytes ?? 512 * MB;
  const usable = Math.max(256 * MB, deps.heapSizeLimit - reserve);
  const floor = deps.baselineHeapUsed + 256 * MB;
  const relief = Math.min(Math.max(floor, 384 * MB), usable);
  const abort = Math.min(Math.max(relief + 128 * MB, Math.floor(usable * 0.6)), usable);
  const exit = Math.min(Math.max(abort + 256 * MB, deps.heapSizeLimit - 64 * MB), deps.heapSizeLimit);
  return { reliefBytes: relief, abortBytes: abort, exitBytes: exit };
}

export function memoryGovernorVerdict(heapUsed: number, t: MemoryGovernorThresholds): MemoryGovernorVerdict {
  if (heapUsed >= t.exitBytes) return 'exit';
  if (heapUsed >= t.abortBytes) return 'abort';
  if (heapUsed >= t.reliefBytes) return 'relief';
  return 'ok';
}

/**
 * Conversation budget for one task: total retained characters of tool-result
 * content in the messages array sent to the model. Oldest tool results are
 * summarized (head + tail) once the budget is exceeded, so a long analysis
 * cannot retain gigabytes of file/command output in the conversation history.
 */
export const CONVERSATION_TOOL_BUDGET_CHARS = 512 * 1024;

/** Keep the most recent tool results verbatim regardless of budget. */
export const TOOL_RESULT_KEEP_RECENT = 8;

/** Per-result summary size when a result is compacted (head/tail). */
export const TOOL_RESULT_SUMMARY_CHARS = 4 * 1024;

/**
 * Compact an oversized tool result string in place (returns new string).
 * Preserves head + tail so file reads stay useful while bounding heap.
 */
export function summarizeToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_SUMMARY_CHARS * 2 + 200) return content;
  const head = content.slice(0, TOOL_RESULT_SUMMARY_CHARS);
  const tail = content.slice(-TOOL_RESULT_SUMMARY_CHARS);
  return `${head}\n\n[…compacted by Mercury memory governor: ${content.length} chars → head+tail. Re-read specific sections if needed.]\n\n${tail}`;
}
/** Newest messages kept verbatim during aggressive compaction. */
export const COMPACTION_KEEP_RECENT = 8;

/**
 * Aggressive conversation compaction — the OpenCode practice: on memory
 * pressure, COMPACT and continue instead of aborting the task. Oldest
 * messages (beyond the recent window) have oversized tool results and long
 * text replaced with head+tail summaries, in place. Returns chars freed.
 * The model keeps full awareness of WHAT was done (tool narrative lives in
 * the step log) and only loses verbatim bulk output it can re-read.
 */
export function compactConversation(messages: unknown[]): number {
  if (messages.length <= COMPACTION_KEEP_RECENT) return 0;
  let freed = 0;
  const cutoff = messages.length - COMPACTION_KEEP_RECENT;
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i] as any;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'tool-result' && typeof part.result === 'string' && part.result.length > TOOL_RESULT_SUMMARY_CHARS * 2) {
          freed += part.result.length;
          part.result = summarizeToolResult(part.result);
        }
      }
    } else if (typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_SUMMARY_CHARS * 2) {
      freed += msg.content.length;
      msg.content = summarizeToolResult(msg.content);
    }
  }
  return freed;
}
