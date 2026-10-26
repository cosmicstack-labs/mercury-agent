import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { UserMemoryStore } from './user-memory.js';
import { SecondBrainDB, isBetterSqlite3Available, type MemoryRow } from './second-brain-db.js';

const tempDirs: string[] = [];

const sqliteAvailable = isBetterSqlite3Available();

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sb-'));
  tempDirs.push(dir);
  return join(dir, 'second-brain', 'second-brain.db');
}

function createStore(dbPath = tempDbPath()): UserMemoryStore {
  const config = getDefaultConfig();
  config.memory.secondBrain = { enabled: true };
  return new UserMemoryStore(config, 'user:owner', dbPath);
}

/** A row the pre-Owner-Model Second Brain would have written. */
function legacyRow(partial: Partial<MemoryRow> & { id: string; summary: string }): Omit<MemoryRow, 'rowid'> {
  const now = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return {
    user_key: 'user:owner', type: 'preference', categories: '[]', shareable: 0, detail: null, scope: 'durable',
    evidence_kind: 'direct', source: 'conversation', confidence: 0.9, importance: 0.8, durability: 0.9, evidence_count: 2,
    provenance: null, dismissed: 0, superseded_by: null, created_at: now, updated_at: now, last_seen_at: now,
    last_used_at: null, last_used_query: null, ...partial,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('UserMemoryStore (facade over the belief store)', () => {
  it.skipIf(!sqliteAvailable)('an explicit save is a confirmed belief the owner stated, and reads back through the old API', () => {
    const store = createStore();
    const [saved] = store.remember([
      { type: 'preference', summary: 'Prefers concise technical answers.', confidence: 0.9, importance: 0.8, durability: 0.9, evidenceKind: 'direct' },
    ]);
    expect(saved.type).toBe('preference');
    expect(saved.evidenceKind).toBe('direct');
    expect(saved.scope).toBe('durable');

    const belief = store.beliefs.get(saved.id);
    expect(belief?.status).toBe('confirmed');
    expect(belief?.ownerStated).toBe(true);

    expect(store.getRecent().map((r) => r.id)).toContain(saved.id);
    expect(store.getById(saved.id)?.summary).toBe('Prefers concise technical answers.');
    expect(store.getSummary().total).toBe(1);
    expect(store.getSummary().byType.preference).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('saving the same thing twice supports the one belief instead of duplicating it', () => {
    const store = createStore();
    store.remember([{ type: 'goal', summary: 'Wants Mercury to become a second brain.', confidence: 0.9, importance: 0.9, durability: 0.9 }]);
    store.remember([{ type: 'goal', summary: 'Wants Mercury to become a second brain.', confidence: 0.9, importance: 0.9, durability: 0.9 }]);
    expect(store.getSummary().total).toBe(1);
    expect(store.getRecent()[0].evidenceCount).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!sqliteAvailable)('an inferred save is only a candidate', () => {
    const store = createStore();
    const [r] = store.remember([
      { type: 'habit', summary: 'Seems to work on projects late in the evening.', confidence: 0.6, importance: 0.6, durability: 0.6, evidenceKind: 'inferred' },
    ]);
    expect(r.evidenceKind).toBe('inferred');
    expect(r.scope).toBe('active');
    expect(store.beliefs.get(r.id)?.status).toBe('candidate');
    expect(store.getByType('habit')).toHaveLength(1);
  });

  it.skipIf(!sqliteAvailable)('never stores a secret, whatever the owner asked', () => {
    const store = createStore();
    const saved = store.remember([
      { type: 'identity', summary: 'My GitHub token is ghp_abcdefghijklmnopqrstuvwxyz0123', confidence: 0.9, importance: 0.9, durability: 0.9 },
    ]);
    expect(saved).toHaveLength(0);
    expect(store.getSummary().total).toBe(0);
  });

  it.skipIf(!sqliteAvailable)('retrieval returns the relevant beliefs as a context block', () => {
    const store = createStore();
    store.remember([
      { type: 'project', summary: 'Is building a personal knowledge management system.', confidence: 0.95, importance: 0.9, durability: 0.9 },
      { type: 'preference', summary: 'Prefers tea over coffee.', confidence: 0.8, importance: 0.5, durability: 0.7 },
    ]);
    const result = store.retrieveRelevant('How should I structure the knowledge management system?', { maxRecords: 3 });
    expect(result.records.length).toBeGreaterThanOrEqual(1);
    expect(result.records[0].summary).toContain('knowledge management');
    expect(result.context).toContain('Relevant user memory:');
    expect(store.retrieveRelevant('zxqv unrelated').records).toHaveLength(0);
  });

  it.skipIf(!sqliteAvailable)('search, update and delete go through the belief store', () => {
    const store = createStore();
    const [r] = store.remember([{ type: 'preference', summary: 'Prefers dark mode everywhere.', confidence: 0.9, importance: 0.7, durability: 0.9 }]);
    expect(store.search('dark mode')[0]?.id).toBe(r.id);

    const updated = store.updateMemory(r.id, { summary: 'Prefers dark mode in every editor.', shareable: true });
    expect(updated?.summary).toBe('Prefers dark mode in every editor.');
    expect(updated?.shareable).toBe(true);
    expect(store.countShareable()).toBe(1);
    expect(store.getShareableSince(0).map((m) => m.id)).toEqual([r.id]);

    expect(store.softDeleteMemory(r.id)).toBe(true);
    expect(store.getSummary().total).toBe(0);
    expect(store.search('dark mode')).toHaveLength(0);
  });

  it.skipIf(!sqliteAvailable)('supports pause and resume of learning', () => {
    const store = createStore();
    store.setLearningPaused(true);
    store.remember([{ type: 'goal', summary: 'Wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 }]);
    expect(store.getSummary().total).toBe(0);
    store.setLearningPaused(false);
    store.remember([{ type: 'goal', summary: 'Wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 }]);
    expect(store.getSummary().total).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('clears all memories', () => {
    const store = createStore();
    store.remember([
      { type: 'identity', summary: 'Is a software developer.', confidence: 0.95, importance: 0.9, durability: 0.9 },
      { type: 'preference', summary: 'Prefers dark mode.', confidence: 0.9, importance: 0.75, durability: 0.85 },
    ]);
    expect(store.getSummary().total).toBe(2);
    expect(store.clear()).toBe(2);
    expect(store.getSummary().total).toBe(0);
    expect(store.getRecent()).toHaveLength(0);
  });

  it.skipIf(!sqliteAvailable)('profile and active summary come from the reflection brief', () => {
    const store = createStore();
    expect(store.getProfile()).toBe('');
    store.beliefs.setMeta('brief', JSON.stringify({ about: 'Builds Mercury.', howToWork: 'Keep replies short.', at: Date.now(), sig: 'x' }));
    expect(store.getProfile()).toBe('Builds Mercury.');
    expect(store.getActiveSummary()).toBe('Keep replies short.');
    expect(store.getSummary().profileSummary).toBe('Builds Mercury.');
    expect(store.consolidate()).toEqual({ profileUpdated: false, reflectionCount: 0 });
  });
});

describe('UserMemoryStore upgrade from a pre-Owner-Model database', () => {
  function seedLegacy(dbPath: string): void {
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const db = new SecondBrainDB(dbPath);
    db.init();
    db.insert(legacyRow({ id: 'm-pref', type: 'preference', summary: 'User prefers concise technical answers.' }));
    db.insert(legacyRow({ id: 'm-proj', type: 'project', summary: 'User is building Mercury, an AI agent.', evidence_count: 1 }));
    db.insert(legacyRow({ id: 'm-junk', type: 'preference', summary: 'I can help you with that! Here is the plan:' }));
    db.insert(legacyRow({ id: 'm-secret', type: 'identity', summary: 'User password is hunter2' }));
    db.setMeta('user:owner:profile_summary', 'Old templated profile');
    db.close();
  }

  it.skipIf(!sqliteAvailable)('boots without error, backs the database up once, and keeps every real memory readable', () => {
    const dbPath = tempDbPath();
    seedLegacy(dbPath);

    const store = createStore(dbPath);
    const backup = dbPath.replace(/\.db$/, '.pre-owner-model.db');
    expect(existsSync(backup)).toBe(true);

    // Real memories are beliefs now; the old API still lists them.
    const summaries = store.getRecent(50).map((r) => r.summary);
    expect(summaries).toContain('User prefers concise technical answers.');
    expect(summaries).toContain('User is building Mercury, an AI agent.');
    expect(summaries.some((s) => s.includes('hunter2'))).toBe(false);
    expect(summaries.some((s) => s.startsWith('I can help'))).toBe(false);
    expect(store.getSummary().total).toBe(2);
    expect(store.search('concise')).toHaveLength(1);

    // Junk went to quarantine, not the bin; the owner can bring it back.
    const quarantined = store.listQuarantined();
    expect(quarantined.map((q) => q.id).sort()).toEqual(['m-junk', 'm-secret']);
    expect(store.restoreQuarantined('m-junk')).toBeTruthy();
    expect(store.listQuarantined().map((q) => q.id)).toEqual(['m-secret']);
    expect(store.getSummary().total).toBe(3);

    // Old summaries never leak: the profile now comes only from the reflection brief.
    expect(store.getProfile()).toBe('');
    store.close();

    // Second boot: nothing migrates twice and nothing is lost.
    const again = createStore(dbPath);
    expect(again.getSummary().total).toBe(3);
    expect(again.listQuarantined().map((q) => q.id)).toEqual(['m-secret']);
    again.close();
  });

  it.skipIf(!sqliteAvailable)('a fresh database needs no backup and starts empty', () => {
    const dbPath = tempDbPath();
    const store = createStore(dbPath);
    expect(existsSync(dbPath.replace(/\.db$/, '.pre-owner-model.db'))).toBe(false);
    expect(store.getSummary().total).toBe(0);
    expect(store.listQuarantined()).toHaveLength(0);
  });
});
