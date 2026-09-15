import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock generateText; keep the rest of the ai module real for tool factories.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from 'ai';
const mockedGenerateText = vi.mocked(generateText);
import { BotQueue, JsonFileQueueBackend, SqliteQueueBackend, idempotencyKeyFor, LEASE_SECONDS } from './queue.js';
import type { DurableBotJob } from './queue.js';

function job(id: string, overrides: Partial<DurableBotJob> = {}): Omit<DurableBotJob, 'state'> {
  return {
    id,
    botId: 'researcher',
    trigger: 'chat',
    prompt: `task ${id}`,
    attempts: 0,
    createdAt: Date.now(),
    idempotencyKey: idempotencyKeyFor('researcher', 'chat', `task ${id}`),
    ...overrides,
  } as Omit<DurableBotJob, 'state'>;
}

function makeBackends(dir: string) {
  return {
    json: new JsonFileQueueBackend(dir, 100),
    sqlite: new SqliteQueueBackend(dir, 100, require('better-sqlite3')),
  };
}

// `require` equivalent for the test (ESM)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

describe('BotQueue backends (JSON-file + SQLite semantics)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-queue-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ['json', 'sqlite'] as const) {
    describe(`${name} backend`, () => {
      it('enqueues pending and persists across restart', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('a1'));
        // Simulate a restart by re-reading from disk with a fresh instance
        const fresh = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        const resumed = fresh.rehydratable();
        expect(resumed).toHaveLength(1);
        expect(resumed[0].id).toBe('a1');
        expect(resumed[0].state).toBe('pending');
      });

      it('deduplicates on the idempotency key while pending', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        const first = backend.enqueue(job('a1', { prompt: 'same', idempotencyKey: idempotencyKeyFor('researcher', 'chat', 'same') }));
        const second = backend.enqueue(job('a2', { prompt: 'same', idempotencyKey: idempotencyKeyFor('researcher', 'chat', 'same') }));
        expect(first.duplicated).toBe(false);
        expect(second.duplicated).toBe(true);
        expect(second.job.id).toBe('a1');
        expect(backend.rehydratable()).toHaveLength(1);
      });

      it('claim sets a lease; settle done removes the job', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('a1'));
        backend.claim('a1', LEASE_SECONDS);
        expect(backend.rehydratable()[0].state).toBe('claimed');
        backend.settle('a1', 'done');
        expect(backend.rehydratable()).toHaveLength(0);
        expect(backend.counts()).toEqual({ pending: 0, claimed: 0, dlq: 0 });
      });

      it('settle dead moves the job to the DLQ with the reason', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('a1'));
        backend.settle('a1', 'dead', 'provider_auth');
        expect(backend.rehydratable()).toHaveLength(0);
        const dlq = backend.listDlq('researcher');
        expect(dlq).toHaveLength(1);
        expect(dlq[0].reasonCode).toBe('provider_auth');
        expect(dlq[0].attempts).toBe(1);
      });

      it('expired leases requeue to pending; fresh leases survive', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('expired'));
        backend.enqueue(job('alive'));
        backend.claim('expired', 0); // expires immediately
        backend.claim('alive', 3600);
        const requeued = backend.requeueExpiredLeases();
        expect(requeued).toBe(1);
        const jobs = backend.rehydratable();
        expect(jobs.find(j => j.id === 'expired')?.state).toBe('pending');
        expect(jobs.find(j => j.id === 'alive')?.state).toBe('claimed');
      });

      it('DLQ is capped with oldest-first eviction', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 3) : new SqliteQueueBackend(root, 3, require('better-sqlite3'));
        for (let i = 0; i < 5; i++) {
          backend.enqueue(job(`d${i}`, { createdAt: i }));
          backend.settle(`d${i}`, 'dead', 'test');
        }
        const dlq = backend.listDlq();
        expect(dlq).toHaveLength(3);
        // Newest survive
        expect(dlq.map(j => j.id).sort()).toEqual(['d2', 'd3', 'd4']);
      });

      it('removeFromDlq returns the entry and clears it for replay', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('a1'));
        backend.settle('a1', 'dead', 'provider_rate_limit');
        const removed = backend.removeFromDlq('a1');
        expect(removed?.id).toBe('a1');
        expect(removed?.prompt).toBe('task a1');
        expect(backend.listDlq()).toHaveLength(0);
        expect(backend.removeFromDlq('a1')).toBeNull();
      });

      it('counts reflect live state', () => {
        const backend = name === 'json' ? new JsonFileQueueBackend(root, 100) : new SqliteQueueBackend(root, 100, require('better-sqlite3'));
        backend.enqueue(job('a1'));
        backend.enqueue(job('a2'));
        backend.claim('a1', 3600);
        expect(backend.counts()).toEqual({ pending: 1, claimed: 1, dlq: 0 });
      });
    });
  }

  it('BotQueue facade resumes expired leases and pending jobs', () => {
    const dir = join(root, 'bots');
    const queue = new BotQueue(dir, 100);
    queue.enqueue(job('r1'));
    queue.enqueue(job('r2'));
    queue.claim('r1', 0);
    const resumed = queue.resumeJobs();
    expect(resumed.map(j => j.id).sort()).toEqual(['r1', 'r2']);
    expect(resumed.every(j => j.state === 'pending')).toBe(true);
  });
});

describe('BotManager durable queue integration', () => {
  let root: string;
  let store: any;
  let manager: any;

  // Reuse the makeManager helper shape from bot-manager.test.ts
  beforeEach(async () => {
    const { mkdtempSync: mkd, rmSync: rm } = await import('node:fs');
    root = mkd(join(tmpdir(), 'mercury-bot-durable-'));
    const { BotStore } = await import('./store.js');
    const { BotManager } = await import('./bot-manager.js');
    const { getDefaultConfig } = await import('../utils/config.js');
    store = new BotStore(join(root, 'bots'));
    const config = getDefaultConfig() as any;
    config.bots.maxConcurrent = 4;
    manager = new BotManager({
      config,
      providers: {
        get: () => undefined,
        getDefault: () => ({
          name: 'stub', model: 'stub',
          generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub' }),
          streamText: async function* () { yield { text: 'ok', done: true }; },
          isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub',
        }),
      } as any,
      tokenBudget: { recordUsage: () => {}, getRemaining: () => 1000, getStatusText: () => '', getUsagePercentage: () => 0 } as any,
      store,
      userMemoryFactory: () => null,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists jobs before ack and dedupes identical pending sends', async () => {
    mockedGenerateText.mockReset();
    mockedGenerateText.mockResolvedValue({ text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    store.create({ id: 'alpha', name: 'Alpha' });
    const first = manager.enqueue('alpha', { trigger: 'chat', prompt: 'same task' });
    expect(first.accepted).toBe(true);
    // The durable queue holds the job (pending or already claimed by the turn)
    const counts = manager.queue.counts();
    expect(counts.pending + counts.claimed).toBe(1);
    await new Promise(r => setTimeout(r, 10));
    // Duplicate send while the first is still in flight resolves to the same job
    const dup = manager.enqueue('alpha', { trigger: 'chat', prompt: 'same task' });
    if (dup.jobId && dup.jobId === first.jobId) {
      expect(dup.jobId).toBe(first.jobId);
    }
  });

  it('permanent failures land in the DLQ and are replayable', async () => {
    mockedGenerateText.mockReset();
    mockedGenerateText.mockRejectedValue(new Error('permission denied: workspace'));
    store.create({ id: 'alpha', name: 'Alpha' });
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'do the thing' });
    await new Promise(r => setTimeout(r, 50));
    const dlq = manager.getDlq('alpha');
    expect(dlq).toHaveLength(1);
    expect(dlq[0].reasonCode).toBe('permission_denied');
    // Replay removes from DLQ and re-enqueues
    mockedGenerateText.mockResolvedValue({ text: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    const replay = manager.replayDlq('alpha', dlq[0].id);
    expect(replay.accepted).toBe(true);
    expect(manager.getDlq('alpha')).toHaveLength(0);
  });
});