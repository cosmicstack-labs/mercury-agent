import { describe, expect, it } from 'vitest';
import { isTaskHeapUnsafe, taskHeapAbortThreshold } from './memory-guard.js';

const MB = 1024 * 1024;

describe('task memory guard', () => {
  it('aborts ordinary tasks at 512MB instead of approaching the V8 limit', () => {
    expect(taskHeapAbortThreshold(2560 * MB, 120 * MB)).toBe(512 * MB);
    expect(isTaskHeapUnsafe(511 * MB, 512 * MB)).toBe(false);
    expect(isTaskHeapUnsafe(512 * MB, 512 * MB)).toBe(true);
  });

  it('allows headroom above a high startup baseline while preserving crash headroom', () => {
    expect(taskHeapAbortThreshold(2560 * MB, 600 * MB)).toBe(856 * MB);
    expect(taskHeapAbortThreshold(1024 * MB, 900 * MB)).toBe(512 * MB);
  });
});
