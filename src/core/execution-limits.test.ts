import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsContinuationApproval, needsRetryApproval, withAbortDeadline } from './execution-limits.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('execution limits', () => {
  it('requires user approval at the hard deadline or after two automatic continuations', () => {
    expect(needsContinuationApproval(0, false)).toBe(false);
    expect(needsContinuationApproval(1, false)).toBe(false);
    expect(needsContinuationApproval(2, false)).toBe(true);
    expect(needsContinuationApproval(0, true)).toBe(true);
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
