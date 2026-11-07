import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tool } from 'ai';

/** The lifetime of a turn, including tools the SDK stopped waiting for. */
export interface ToolExecutionScope {
  accepting: boolean;
  readonly pending: Set<Promise<unknown>>;
  readonly iterators: Set<AsyncIterator<unknown>>;
  readonly signal?: AbortSignal;
}

const executionStore = new AsyncLocalStorage<ToolExecutionScope>();

export function currentToolExecutionScope(): ToolExecutionScope | undefined {
  return executionStore.getStore();
}

export function isToolExecutionCancelled(): boolean {
  return currentToolExecutionScope()?.signal?.aborted === true;
}

/** Track the underlying operation, not a timeout/abort race around it. */
export function trackToolExecution<T>(operation: PromiseLike<T>, scope = currentToolExecutionScope()): Promise<T> {
  const pending = Promise.resolve(operation);
  if (scope) {
    scope.pending.add(pending);
    // Both handlers consume rejection; a detached finally() would create an
    // unhandled rejected promise when a tool fails after SDK cancellation.
    void pending.then(() => scope.pending.delete(pending), () => scope.pending.delete(pending));
  }
  return pending;
}

/** Close admission and wait before cleanup changes permissions, cwd or locks. */
export async function drainToolExecutions(): Promise<void> {
  const scope = currentToolExecutionScope();
  if (!scope) return;
  scope.accepting = false;
  for (const iterator of scope.iterators) {
    scope.iterators.delete(iterator);
    if (iterator.return) trackToolExecution(Promise.resolve().then(() => iterator.return!()), scope);
  }
  while (scope.pending.size) await Promise.allSettled([...scope.pending]);
}

export async function withToolExecutionScope<T>(fn: () => T | PromiseLike<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  const scope: ToolExecutionScope = { accepting: true, pending: new Set(), iterators: new Set(), signal: options.signal };
  return executionStore.run(scope, async () => {
    try {
      return await fn();
    } finally {
      // A tool may start a nested operation before settling (e.g. a plugin
      // invocation whose timeout already fired). Drain until all settle.
      await drainToolExecutions();
    }
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}

/** Keep descriptors intact; execution stays bound to the turn that exposed it. */
export function trackTools(tools: Record<string, Tool>): Record<string, Tool> {
  const scope = currentToolExecutionScope();
  if (!scope) return tools;
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    const execute = definition.execute;
    if (!execute) return [name, definition];
    return [name, {
      ...definition,
      execute: (input, options) => {
        if (!scope.accepting || scope.signal?.aborted || currentToolExecutionScope() !== scope || options.abortSignal?.aborted) {
          throw new Error(`Tool ${name} was not run: its turn has stopped.`);
        }
        const abortSignal = scope.signal && options.abortSignal && scope.signal !== options.abortSignal
          ? AbortSignal.any([scope.signal, options.abortSignal])
          : options.abortSignal ?? scope.signal;
        const result = execute(input, { ...options, abortSignal });
        if (isAsyncIterable(result)) {
          // Streaming tools do work when the iterator advances. Keep each
          // underlying operation alive even if its consumer stops waiting.
          return {
            [Symbol.asyncIterator]() {
              if (!scope.accepting || currentToolExecutionScope() !== scope) {
                throw new Error(`Tool ${name} was stopped.`);
              }
              const iterator = result[Symbol.asyncIterator]();
              scope.iterators.add(iterator);
              return {
                next: (...args: [] | [unknown]) => {
                  if (!scope.accepting || currentToolExecutionScope() !== scope || abortSignal?.aborted) {
                    return Promise.reject(new Error(`Tool ${name} was stopped.`));
                  }
                  return trackToolExecution(Promise.resolve(iterator.next(...args)).then((step) => {
                    if (step.done) scope.iterators.delete(iterator);
                    return step;
                  }), scope);
                },
                return: iterator.return ? (value?: unknown) => {
                  if (!scope.iterators.delete(iterator)) return Promise.resolve({ done: true as const, value });
                  return trackToolExecution(iterator.return!(value), scope);
                } : undefined,
                throw: iterator.throw ? (error?: unknown) => {
                  if (!scope.accepting || currentToolExecutionScope() !== scope) return Promise.reject(error);
                  return trackToolExecution(Promise.resolve(iterator.throw!(error)).then((step) => {
                    if (step.done) scope.iterators.delete(iterator);
                    return step;
                  }), scope);
                } : undefined,
              };
            },
          };
        }
        return trackToolExecution(Promise.resolve(result), scope);
      },
    } satisfies Tool];
  }));
}
