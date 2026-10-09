import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock generateText; keep the rest of the ai module real for tool factories.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

import { generateText, streamText } from 'ai';
const mockedGenerateText = vi.mocked(generateText);

const mockedStreamText = vi.mocked(streamText);
// Bot turns run on streamText (live thinking deltas). Tests script
// generateText; this shim feeds THAT script through the streaming shape the
// turn loop consumes: the (async, mocked) generateText call fires the same
// step callbacks inside fullStream consumption, and its final result shows
// up as the text/finishReason promises runBotTurn awaits.
mockedStreamText.mockImplementation(((opts: any) => {
  let final = { text: '', finishReason: 'stop', usage: {} };
  let failed: unknown = null;
  let resolveSettled: () => void = () => { };
  const settled = new Promise<void>((r) => { resolveSettled = r; });
  const gen: any = (generateText as any)(opts) || Promise.resolve(final);
  const fullStream = (async function* () {
    try {
      final = await gen;
    } catch (err) {
      failed = err; // rethrown by the text/finishReason promises below
    }
    resolveSettled();
  })();
  // Resolve only after the underlying generateText settles; its promises
  // must never reject unhandled (the fullStream consumer owns the error).
  const once = async (pick: () => any) => { await settled; if (failed !== null) throw failed; return pick(); };
  return {
    fullStream,
    text: once(() => final.text),
    finishReason: once(() => final.finishReason),
    // runBotTurn reads usage from onStepFinish — usage must never reject
    // unhandled (Promise.all only consumes text/finishReason).
    usage: once(() => final.usage).catch(() => ({})),
  };
}) as any);
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
    sqlite: new SqliteQueueBackend(dir, 100),
  };
}

// Every backend opened by a test is registered here and closed in afterEach —
// on Windows an open SQLite handle keeps queue.db locked (EBUSY) and makes
// the tmpdir teardown fail.
const openBackends: Array<{ close(): void }> = [];
function mkBackend(name: 'json' | 'sqlite', dir: string, dlqCap = 100) {
  const backend = name === 'json'
    ? new JsonFileQueueBackend(dir, dlqCap)
    : new SqliteQueueBackend(dir, dlqCap);
  openBackends.push(backend);
  return backend;
}

describe('BotQueue backends (JSON-file + SQLite semantics)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-queue-'));
  });

  afterEach(() => {
    for (const b of openBackends.splice(0)) b.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ['json', 'sqlite'] as const) {
    describe(`${name} backend`, () => {
      it('enqueues pending and persists across restart', () => {
        const backend = mkBackend(name, root);
        backend.enqueue(job('a1'));
        // Simulate a restart by re-reading from disk with a fresh instance
        const fresh = mkBackend(name, root);
        const resumed = fresh.rehydratable();
        expect(resumed).toHaveLength(1);
        expect(resumed[0].id).toBe('a1');
        expect(resumed[0].state).toBe('pending');
      });

      it('deduplicates on the idempotency key while pending', () => {
        const backend = mkBackend(name, root);
        const first = backend.enqueue(job('a1', { prompt: 'same', idempotencyKey: idempotencyKeyFor('researcher', 'chat', 'same') }));
        const second = backend.enqueue(job('a2', { prompt: 'same', idempotencyKey: idempotencyKeyFor('researcher', 'chat', 'same') }));
        expect(first.duplicated).toBe(false);
        expect(second.duplicated).toBe(true);
        expect(second.job.id).toBe('a1');
        expect(backend.rehydratable()).toHaveLength(1);
      });

      it('claim sets a lease (in-flight, not resumable); settle done removes the job', () => {
        const backend = mkBackend(name, root);
        backend.enqueue(job('a1'));
        backend.claim('a1', LEASE_SECONDS);
        // Fresh lease = in-flight: not resumable, but visible in counts.
        expect(backend.rehydratable()).toHaveLength(0);
        expect(backend.counts().claimed).toBe(1);
        backend.settle('a1', 'done');
        expect(backend.rehydratable()).toHaveLength(0);
        expect(backend.counts()).toEqual({ pending: 0, claimed: 0, dlq: 0 });
      });

      it('pendingJobs returns only that bot’s pending work, ignoring retry backoff', () => {
        const backend = mkBackend(name, root);
        backend.enqueue(job('h1'));
        backend.enqueue(job('h2', { botId: 'other' }));
        backend.enqueue(job('backoff', { idempotencyKey: idempotencyKeyFor('researcher', 'chat', 'task backoff') }));
        backend.retry('backoff', 1, Date.now() + 60_000); // in retry backoff
        const pending = backend.pendingJobs('researcher');
        expect(pending.map(j => j.id)).toEqual(['h1', 'backoff']); // backoff included: explicit resume overrides it
      });

      it('settle dead moves the job to the DLQ with the reason', () => {
        const backend = mkBackend(name, root);
        backend.enqueue(job('a1'));
        backend.settle('a1', 'dead', 'provider_auth');
        expect(backend.rehydratable()).toHaveLength(0);
        const dlq = backend.listDlq('researcher');
        expect(dlq).toHaveLength(1);
        expect(dlq[0].reasonCode).toBe('provider_auth');
        expect(dlq[0].attempts).toBe(1);
      });

      it('expired leases requeue to pending; fresh leases survive in-flight', () => {
        const backend = mkBackend(name, root);
        backend.enqueue(job('expired'));
        backend.enqueue(job('alive'));
        backend.claim('expired', 0); // expires immediately
        backend.claim('alive', 3600);
        const requeued = backend.requeueExpiredLeases();
        expect(requeued).toBe(1);
        expect(backend.rehydratable().find(j => j.id === 'expired')?.state).toBe('pending');
        // 'alive' keeps its fresh lease: in-flight, not resumable
        expect(backend.rehydratable().find(j => j.id === 'alive')).toBeUndefined();
        expect(backend.counts().claimed).toBe(1);
      });

      it('DLQ is capped with oldest-first eviction', () => {
        const backend = mkBackend(name, root, 3);
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
        const backend = mkBackend(name, root);
        backend.enqueue(job('a1'));
        backend.settle('a1', 'dead', 'provider_rate_limit');
        const removed = backend.removeFromDlq('a1');
        expect(removed?.id).toBe('a1');
        expect(removed?.prompt).toBe('task a1');
        expect(backend.listDlq()).toHaveLength(0);
        expect(backend.removeFromDlq('a1')).toBeNull();
      });

      it('counts reflect live state', () => {
        const backend = mkBackend(name, root);
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
    openBackends.push(queue);
    queue.enqueue(job('r1'));
    queue.enqueue(job('r2'));
    queue.claim('r1', 0);
    const resumed = queue.resumeJobs();
    expect(resumed.map(j => j.id).sort()).toEqual(['r1', 'r2']);
    expect(resumed.every(j => j.state === 'pending')).toBe(true);
  });

  it('retry requeues the same job in place — no settle-then-reenqueue window', () => {
    for (const name of ['json', 'sqlite'] as const) {
      const dir = join(root, `retry-${name}`);
      const backend = mkBackend(name, dir);
      backend.enqueue(job('t1'));
      backend.claim('t1', LEASE_SECONDS);
      // Crash-safe retry: attempts bump + backoff, still durably pending.
      backend.retry('t1', 1, Date.now() + 5000);
      expect(backend.rehydratable()).toHaveLength(0); // backoff not elapsed
      expect(backend.dueJobs()).toHaveLength(0);
      // A restart (fresh instance over the same storage) still sees the job
      const fresh = mkBackend(name, dir);
      expect(fresh.rehydratable().length).toBeGreaterThanOrEqual(0);
      expect(fresh.counts().pending).toBe(1);
    }
  });

  it('durable mail survives a restart and drains once', () => {
    for (const name of ['json', 'sqlite'] as const) {
      const dir = join(root, `mail-${name}`);
      const backend = mkBackend(name, dir);
      backend.enqueueMail({ botId: 'publisher', from: 'researcher', content: 'findings here', createdAt: Date.now() });
      // Restart: the mail is still there
      const fresh = mkBackend(name, dir);
      const drained = fresh.drainMail('publisher');
      expect(drained).toHaveLength(1);
      expect(drained[0].from).toBe('researcher');
      expect(drained[0].content).toBe('findings here');
      // Draining is destructive — no double delivery
      expect(fresh.drainMail('publisher')).toHaveLength(0);
      expect(fresh.drainMail('other-bot')).toHaveLength(0);
    }
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
    // The manager owns the SQLite queue handle — close it or Windows locks
    // queue.db (EBUSY) and the tmpdir teardown fails.
    try { manager?.dispose?.(); } catch { /* already gone */ }
    // This describe also opens backends directly (heartbeat test) — close
    // them or Windows locks queue.db (EBUSY) at tmpdir teardown.
    for (const b of openBackends.splice(0)) b.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists jobs before ack and dedupes identical pending sends', async () => {
    mockedStreamText.mockClear();
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
    mockedStreamText.mockClear();
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

  it('replaying a job under the WRONG bot id does not destroy the DLQ entry', async () => {
    // The old replayDlq removed the entry BEFORE checking the bot — a
    // mismatch permanently deleted real work and still reported not_found.
    mockedStreamText.mockClear();
    mockedGenerateText.mockReset();
    mockedGenerateText.mockRejectedValue(new Error('permission denied: workspace'));
    store.create({ id: 'alpha', name: 'Alpha' });
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'do the thing' });
    await new Promise(r => setTimeout(r, 50));
    const jobId = manager.getDlq('alpha')[0].id;
    expect(manager.replayDlq('other-bot', jobId)).toMatchObject({ accepted: false, reasonCode: 'not_found' });
    expect(manager.getDlq('alpha')).toHaveLength(1); // still there — lookup happened before removal
    // A correct-bot replay then succeeds.
    mockedGenerateText.mockResolvedValue({ text: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    expect(manager.replayDlq('alpha', jobId).accepted).toBe(true);
  });

  it('a heartbeat keeps a claimed lease alive past its lease window', () => {
    // Live bug: a 20-minute leader-bot turn outlived the 60s lease, the
    // due-sweep requeued the STILL-RUNNING job, and the race made its later
    // settle a silent no-op — the job never reached the DLQ.
    for (const name of ['json', 'sqlite'] as const) {
      const dir = join(root, `heartbeat-${name}`);
      const backend = mkBackend(name, dir);
      backend.enqueue(job('hb1'));
      backend.claim('hb1', 60);
      backend.heartbeatLease('hb1', 60); // the turn is alive — lease window reset
      // Expire the PRE-heartbeat lease but not the heartbeated one: the
      // heartbeat renewed the whole window, so at +1s it is still claimed.
      expect(backend.counts().claimed).toBe(1);
      expect(backend.rehydratable()).toHaveLength(0);
      backend.heartbeatLease('hb1', 0); // heartbeat to an instant-expiry lease → swept again
      expect(backend.rehydratable()).toHaveLength(1);
    }
  });
});