import { logger } from '../utils/logger.js';

export interface SharedMemoryQueryResult {
  friendTgId: string;
  context: string;
  timedOut: boolean;
}

type QueryResolver = {
  resolve: (result: SharedMemoryQueryResult) => void;
  timer: NodeJS.Timeout;
  attempt: number;
};

const QUERY_TIMEOUT_MS = 60_000;

export class SharedMemoryQueryResolver {
  private pending = new Map<string, QueryResolver>();

  key(friendTgId: string): string {
    return `query:${friendTgId}`;
  }

  register(friendTgId: string): Promise<SharedMemoryQueryResult> {
    const k = this.key(friendTgId);
    const existing = this.pending.get(k);
    if (existing) {
      return new Promise<SharedMemoryQueryResult>((resolve) => {
        const origResolve = existing.resolve;
        const patched = { ...existing, resolve: (result: SharedMemoryQueryResult) => {
          origResolve(result);
          resolve(result);
        }};
        this.pending.set(k, patched);
      });
    }

    return new Promise<SharedMemoryQueryResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(k);
        logger.warn({ friendTgId }, 'Shared memory query timed out');
        resolve({ friendTgId, context: '', timedOut: true });
      }, QUERY_TIMEOUT_MS);

      this.pending.set(k, { resolve, timer, attempt: 1 });
    });
  }

  resolve(friendTgId: string, context: string): boolean {
    const k = this.key(friendTgId);
    const entry = this.pending.get(k);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(k);
    entry.resolve({ friendTgId, context, timedOut: false });
    logger.info({ friendTgId, contextLength: context.length }, 'Shared memory query resolved');
    return true;
  }
}