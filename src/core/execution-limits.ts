export const MAX_PROVIDER_ATTEMPT_MS = 10 * 60 * 1000;
export const MAX_AUTOMATIC_CONTINUATIONS = 2;
export const MAX_AUTOMATIC_RETRIES = 3;

export function needsContinuationApproval(continuationAttempt: number, reachedHardDeadline: boolean): boolean {
  return reachedHardDeadline || continuationAttempt >= MAX_AUTOMATIC_CONTINUATIONS;
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
