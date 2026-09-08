const MB = 1024 * 1024;

/**
 * Leave enough heap for abort handling, persistence, and one final TUI render.
 * Tool results are bounded elsewhere, so a task exceeding this is unhealthy.
 */
export function taskHeapAbortThreshold(heapSizeLimit: number, baselineHeapUsed: number): number {
  const desired = Math.max(512 * MB, baselineHeapUsed + 256 * MB);
  const safeCeiling = Math.max(256 * MB, heapSizeLimit - 512 * MB);
  return Math.min(desired, safeCeiling);
}

export function isTaskHeapUnsafe(heapUsed: number, threshold: number): boolean {
  return heapUsed >= threshold;
}

/**
 * Emergency ceiling: if heap keeps growing past the task threshold after an
 * abort attempt, the allocator is running outside the abortable path. Beyond
 * this point a V8 fatal OOM is certain and graceful persistence becomes
 * impossible, so the process must exit deliberately while the work ledger is
 * still writable.
 */
export function taskHeapExitThreshold(heapSizeLimit: number, baselineHeapUsed: number): number {
  return taskHeapAbortThreshold(heapSizeLimit, baselineHeapUsed) + 256 * MB;
}
