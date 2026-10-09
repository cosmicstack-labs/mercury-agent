import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectStorageReport, formatStorageReport, jsonOnlyFixHint } from './storage-doctor.js';
import { SQLITE_BACKEND_ENV, isSqliteAvailable, openSqlite, resetSqliteDriverForTests } from './sqlite-driver.js';
import { SecondBrainDB } from '../memory/second-brain-db.js';
import { SqliteQueueBackend } from '../bots/queue.js';

const savedBackend = process.env[SQLITE_BACKEND_ENV];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-storage-doctor-'));
  delete process.env[SQLITE_BACKEND_ENV];
  resetSqliteDriverForTests();
});

afterEach(() => {
  if (savedBackend === undefined) delete process.env[SQLITE_BACKEND_ENV];
  else process.env[SQLITE_BACKEND_ENV] = savedBackend;
  resetSqliteDriverForTests();
  rmSync(home, { recursive: true, force: true });
});

function byId(report: ReturnType<typeof collectStorageReport>, id: string) {
  const sub = report.subsystems.find((s) => s.id === id);
  if (!sub) throw new Error(`missing subsystem ${id}`);
  return sub;
}

describe('storage doctor', () => {
  it.skipIf(!isSqliteAvailable())('reports the active engine and row counts for every SQLite store', () => {
    const brain = new SecondBrainDB(join(home, 'memory', 'second-brain', 'second-brain.db'));
    brain.init();
    const now = Date.now();
    for (const [id, dismissed] of [['m1', 0], ['m2', 0], ['m3', 1]] as const) {
      brain.insert({
        id, user_key: 'user:owner', type: 'preference', categories: '[]', shareable: 0, summary: `memory ${id}`,
        detail: null, scope: 'durable', evidence_kind: 'direct', source: 'conversation', confidence: 0.9,
        importance: 0.5, durability: 0.5, evidence_count: 1, provenance: null, dismissed, superseded_by: null,
        created_at: now, updated_at: now, last_seen_at: now, last_used_at: null, last_used_query: null,
      });
    }
    brain.upsertPerson({ userKey: 'user:owner', name: 'Ada' });
    brain.close();

    const queue = new SqliteQueueBackend(join(home, 'bots'), 10);
    queue.enqueue({ id: 'j1', botId: 'b', trigger: 'chat', prompt: 'p', attempts: 0, createdAt: now, idempotencyKey: 'k1' });
    queue.enqueue({ id: 'j2', botId: 'b', trigger: 'chat', prompt: 'q', attempts: 0, createdAt: now, idempotencyKey: 'k2' });
    queue.claim('j2', 60);
    queue.enqueueMail({ botId: 'b', from: 'c', content: 'hi', createdAt: now });
    queue.close();

    mkdirSync(join(home, 'memory'), { recursive: true });
    const cache = openSqlite(join(home, 'memory', 'pool-search-cache.db'))!;
    cache.exec('CREATE TABLE pool_search_cache (query_hash TEXT PRIMARY KEY, query TEXT, results_json TEXT, fetched_at INTEGER)');
    cache.prepare('INSERT INTO pool_search_cache VALUES (?, ?, ?, ?)').run('h', 'q', '[]', now);
    cache.close();

    const report = collectStorageReport({ home, probeAll: true });
    expect(report.home).toBe(home);
    expect(report.jsonOnly).toBe(false);
    expect(report.backend.backend).not.toBeNull();
    expect(report.backend.candidates.some((c) => c.status === 'active')).toBe(true);

    const brainReport = byId(report, 'second-brain');
    expect(brainReport.mode).toBe('sqlite');
    expect(brainReport.exists).toBe(true);
    expect(brainReport.bytes).toBeGreaterThan(0);
    expect(brainReport.counts).toMatchObject({ memories: 3, 'memories (active)': 2, persons: 1, relationships: 0 });
    expect(brainReport.error).toBeUndefined();

    const queueReport = byId(report, 'bots-queue');
    expect(queueReport.mode).toBe('sqlite');
    expect(queueReport.counts).toMatchObject({ 'jobs (pending)': 1, 'jobs (claimed)': 1, 'dead-letter': 0, mail: 1 });

    const boardsReport = byId(report, 'boards');
    expect(boardsReport.mode).toBe('sqlite');
    expect(boardsReport.exists).toBe(false);
    expect(boardsReport.counts).toEqual({});

    expect(byId(report, 'pool-search-cache').counts).toEqual({ 'cached queries': 1 });

    const text = formatStorageReport(report).join('\n');
    expect(text).toContain('Mercury Storage Doctor');
    expect(text).toContain(report.backend.backend!);
    expect(text).toContain('memories 3');
    expect(text).not.toContain('JSON-only');
  });

  it('flags JSON-only storage, reads the JSON stores and gives a fix hint', () => {
    process.env[SQLITE_BACKEND_ENV] = 'json';
    resetSqliteDriverForTests();
    mkdirSync(join(home, 'bots'), { recursive: true });
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(join(home, 'bots', 'queue.json'), JSON.stringify({
      jobs: [{ id: 'a', state: 'pending' }, { id: 'b', state: 'claimed' }, { id: 'c', state: 'pending' }],
      dlq: [{ id: 'd' }],
      mails: [],
    }));
    writeFileSync(join(home, 'memory', 'boards.json'), JSON.stringify({ boards: [{ id: 'x' }, { id: 'y' }] }));
    writeFileSync(join(home, 'memory', 'board-contexts.json'), JSON.stringify({ x: {} }));

    const report = collectStorageReport({ home });
    expect(report.jsonOnly).toBe(true);
    expect(report.backend.backend).toBeNull();
    expect(report.backend.override).toBe('json');
    expect(byId(report, 'second-brain').mode).toBe('disabled');
    expect(byId(report, 'pool-search-cache').mode).toBe('disabled');
    expect(byId(report, 'bots-queue')).toMatchObject({
      mode: 'json',
      counts: { 'jobs (pending)': 2, 'jobs (claimed)': 1, 'dead-letter': 1, mail: 0 },
    });
    expect(byId(report, 'boards')).toMatchObject({ mode: 'json', counts: { boards: 2, contexts: 1 } });

    expect(jsonOnlyFixHint(report)[0]).toContain(SQLITE_BACKEND_ENV);
    const text = formatStorageReport(report).join('\n');
    expect(text).toContain('JSON-only');
    expect(text).toContain('DISABLED');
  });

  it('suggests Node 22.13+ or a rebuild when no engine loads on an older Node', () => {
    const report = collectStorageReport({ home });
    const fake = {
      ...report,
      jsonOnly: true,
      backend: { ...report.backend, backend: null, override: null, runtime: 'node' as const, runtimeVersion: '20.20.2' },
    };
    const hints = jsonOnlyFixHint(fake);
    expect(hints.some((h) => h.includes('Node 22.13+'))).toBe(true);
    expect(hints.some((h) => h.includes('npm rebuild better-sqlite3'))).toBe(true);
  });
});
