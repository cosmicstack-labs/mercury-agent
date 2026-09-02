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
