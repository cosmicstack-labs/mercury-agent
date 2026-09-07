export const MAX_PROVIDER_ATTEMPT_MS = 10 * 60 * 1000;
/**
 * Continuations (step-budget resumes, provider-failure resumes) run
 * AUTOMATICALLY — the user asked for "keep on continuing" instead of a
 * manual "continue" gate mid-task. The bound is a runaway backstop, not a
 * checkpoint: long coding sessions routinely need several fresh budgets.
 */
export const MAX_AUTOMATIC_CONTINUATIONS = 6;
export const MAX_AUTOMATIC_RETRIES = 3;

/**
 * Approval is only demanded at the runaway backstop. A provider hard
 * deadline no longer pauses for the user — the failed attempt counts
 * toward the automatic bound and the loop keeps going.
 */
export function needsContinuationApproval(continuationAttempt: number, reachedHardDeadline?: boolean): boolean {
  void reachedHardDeadline;
  return continuationAttempt >= MAX_AUTOMATIC_CONTINUATIONS;
}

export function needsRetryApproval(attempts: number): boolean {
  return attempts >= MAX_AUTOMATIC_RETRIES;
}

export function withAbortDeadline<T>(
  operation: PromiseLike<T>,
  controller: AbortController,
  remainingMs: number,
  onTimeout: () => void,
): Promise<T> {
  if (remainingMs <= 0) {
    onTimeout();
    controller.abort();
    return Promise.reject(new Error('Provider attempt exceeded its hard time limit'));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      controller.abort();
      reject(new Error('Provider attempt exceeded its hard time limit'));
    }, remainingMs);
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
