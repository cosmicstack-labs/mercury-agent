import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUTOMATIC_CONTINUATIONS, needsContinuationApproval, needsRetryApproval, withAbortDeadline } from './execution-limits.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('execution limits', () => {
  it('continues automatically — approval only at the runaway backstop', () => {
    // User decision: "keep on continuing" mid-task. A provider hard
    // deadline no longer pauses for the user; the failed attempt counts
    // toward the automatic bound instead.
    expect(needsContinuationApproval(0, false)).toBe(false);
    expect(needsContinuationApproval(3, true)).toBe(false);
    expect(needsContinuationApproval(MAX_AUTOMATIC_CONTINUATIONS - 1, true)).toBe(false);
    expect(needsContinuationApproval(MAX_AUTOMATIC_CONTINUATIONS, false)).toBe(true);
    expect(needsRetryApproval(2)).toBe(false);
    expect(needsRetryApproval(3)).toBe(true);
  });

  it('rejects and aborts when an underlying provider promise never settles', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onTimeout = vi.fn();
    const operation = new Promise<string>(() => {});
    const result = withAbortDeadline(operation, controller, 100, onTimeout);
    const rejection = expect(result).rejects.toThrow('hard time limit');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });

  it('clears the deadline when the provider settles normally', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onTimeout = vi.fn();

    await expect(withAbortDeadline(Promise.resolve('done'), controller, 100, onTimeout)).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(100);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
