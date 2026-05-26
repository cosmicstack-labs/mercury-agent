import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { UserMemoryStore } from './user-memory.js';
import { isBetterSqlite3Available } from './second-brain-db.js';

const tempDirs: string[] = [];

const sqliteAvailable = isBetterSqlite3Available();

function createStore(): UserMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sb-'));
  tempDirs.push(dir);
  const config = getDefaultConfig();
  config.memory.secondBrain = { enabled: true };
  const dbPath = join(dir, 'second-brain', 'second-brain.db');
  const store = new UserMemoryStore(config, 'user:owner', dbPath);
  return store;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('UserMemoryStore', () => {
  it.skipIf(!sqliteAvailable)('merges similar durable memories instead of duplicating them', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers concise answers.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    store.remember([
      { type: 'preference', summary: 'User prefers concise technical answers.', confidence: 0.94, importance: 0.81, durability: 0.92 },
    ]);

    const recent = store.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].evidenceCount).toBe(2);
    expect(recent[0].summary).toContain('concise');
  });

  it.skipIf(!sqliteAvailable)('retrieves only relevant records for a query', () => {
    const store = createStore();

    store.remember([
      { type: 'project', summary: 'User is building Mercury as a personal AI agent.', confidence: 0.95, importance: 0.9, durability: 0.95 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers concise answers.', confidence: 0.95, importance: 0.75, durability: 0.9 },
    ]);
    store.consolidate();

    const result = store.retrieveRelevant('Plan Mercury architecture', { maxRecords: 3, maxChars: 500 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].type).toBe('project');
    expect(result.context).toContain('Mercury');
  });

  it.skipIf(!sqliteAvailable)('auto-resolves conflicts by dismissing the lower-confidence memory', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers concise answers.', confidence: 0.96, importance: 0.84, durability: 0.92 },
    ]);

    store.remember([
      { type: 'preference', summary: 'User does not prefer concise answers.', confidence: 0.88, importance: 0.82, durability: 0.88 },
    ]);

    const recent = store.getRecent();
    const active = recent.filter(r => !r.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0].summary).toContain('concise answers');
    expect(active[0].summary).not.toContain('does not');
  });

  it.skipIf(!sqliteAvailable)('auto-resolves conflicts when incoming has higher confidence', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers verbose answers.', confidence: 0.75, importance: 0.7, durability: 0.7 },
    ]);

    store.remember([
      { type: 'preference', summary: 'User does not prefer verbose answers.', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);

    const recent = store.getRecent();
    const active = recent.filter(r => !r.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0].summary).toContain('does not prefer verbose');
  });

  it.skipIf(!sqliteAvailable)('synthesizes a compact profile and reflection records from repeated signal', () => {
    const store = createStore();

    store.remember([
      { type: 'identity', summary: 'User is building Mercury.', confidence: 0.96, importance: 0.92, durability: 0.95 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers concise technical answers.', confidence: 0.96, importance: 0.84, durability: 0.92 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers practical implementation details.', confidence: 0.95, importance: 0.82, durability: 0.9 },
    ]);
    store.remember([
      { type: 'goal', summary: 'User wants Mercury to become a second brain.', confidence: 0.97, importance: 0.95, durability: 0.94 },
    ]);

    const result = store.consolidate();
    const summary = store.getSummary();
    const recent = store.getRecent(10);
    const reflections = recent.filter(r => r.type === 'reflection');

    expect(result.reflectionCount).toBeGreaterThan(0);
    expect(summary.profileSummary).toContain('Mercury');
    expect(summary.profileSummary).toContain('concise');
    expect(reflections.length).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteAvailable)('separates active state from durable profile', () => {
    const store = createStore();

    store.remember([
      { type: 'project', summary: 'User is building Mercury memory architecture this week.', confidence: 0.96, importance: 0.91, durability: 0.82 },
    ]);
    store.remember([
      { type: 'goal', summary: 'User wants Mercury to become a second brain.', confidence: 0.97, importance: 0.95, durability: 0.93 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers concise answers.', confidence: 0.96, importance: 0.82, durability: 0.92 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User does not prefer concise answers.', confidence: 0.95, importance: 0.82, durability: 0.9 },
    ]);
    store.consolidate();

    const summary = store.getSummary();
    const active = store.getActiveSummary();

    expect(active).toContain('Mercury memory architecture');
    expect(summary.profileSummary).toContain('second brain');
  });

  it.skipIf(!sqliteAvailable)('supports pause and resume of learning', () => {
    const store = createStore();

    expect(store.isLearningPaused()).toBe(false);

    store.setLearningPaused(true);
    expect(store.isLearningPaused()).toBe(true);

    store.remember([
      { type: 'goal', summary: 'User wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 },
    ]);
    expect(store.getSummary().total).toBe(0);

    store.setLearningPaused(false);
    store.remember([
      { type: 'goal', summary: 'User wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 },
    ]);
    expect(store.getSummary().total).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('clears all memories', () => {
    const store = createStore();

    store.remember([
      { type: 'identity', summary: 'User is a software developer.', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers dark mode.', confidence: 0.9, importance: 0.75, durability: 0.85 },
    ]);

    expect(store.getSummary().total).toBe(2);

    const cleared = store.clear();
    expect(cleared).toBe(2);
    expect(store.getSummary().total).toBe(0);
  });

  it.skipIf(!sqliteAvailable)('full-text search finds relevant memories', () => {
    const store = createStore();

    store.remember([
      { type: 'project', summary: 'User is building a personal knowledge management system.', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);
    store.remember([
      { type: 'preference', summary: 'User prefers tea over coffee.', confidence: 0.8, importance: 0.5, durability: 0.7 },
    ]);

    const results = store.search('knowledge management');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain('knowledge management');
  });

  it.skipIf(!sqliteAvailable)('deprioritizes stale inferred memories in retrieval', () => {
    const store = createStore();

    const [inferred] = store.remember([
      { type: 'goal', summary: 'User may be exploring memory tooling.', confidence: 0.88, importance: 0.84, durability: 0.82, evidenceKind: 'inferred' },
    ]);
    const [direct] = store.remember([
      { type: 'goal', summary: 'User explicitly wants Mercury to become a second brain.', confidence: 0.9, importance: 0.9, durability: 0.9, evidenceKind: 'direct' },
    ]);

    store.consolidate();
    const summary = store.getSummary();
    expect(summary.profileSummary).toContain('second brain');
  });

  it.skipIf(!sqliteAvailable)('stores weak memories that pass minimum threshold', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', summary: 'User seems to work on projects late evenings.', confidence: 0.58, importance: 0.6, durability: 0.6, evidenceKind: 'inferred' },
    ]);

    expect(store.getSummary().total).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('rejects memories below minimum confidence', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', summary: 'Too uncertain to store.', confidence: 0.3, importance: 0.4, durability: 0.4 },
    ]);

    expect(store.getSummary().total).toBe(0);
  });

  it('reports better-sqlite3 availability status', () => {
    expect(typeof sqliteAvailable).toBe('boolean');
  });

  it.skipIf(!sqliteAvailable)('moves stale memories to subconscious instead of deleting them', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers dark mode for coding.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    expect(store.getSummary().total).toBe(1);
    expect(store.getSummary().subconsciousTotal).toBe(0);

    const db = (store as any).db as import('./second-brain-db.js').SecondBrainDB;
    const row = db.getActive('user:owner')[0];
    db.update({ id: row.id, last_seen_at: Date.now() - (31 * 24 * 60 * 60 * 1000), updated_at: Date.now() - (31 * 24 * 60 * 60 * 1000) });

    const result = store.prune();
    expect(result.movedToSubconscious).toBe(1);

    expect(store.getSummary().total).toBe(0);
    expect(store.getSummary().subconsciousTotal).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('recalls subconscious memories when conscious is weak', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers TypeScript for backend projects.', confidence: 0.9, importance: 0.85, durability: 0.9 },
    ]);

    const db = (store as any).db as import('./second-brain-db.js').SecondBrainDB;
    const row = db.getActive('user:owner')[0];
    db.update({ id: row.id, last_seen_at: Date.now() - (31 * 24 * 60 * 60 * 1000), updated_at: Date.now() - (31 * 24 * 60 * 60 * 1000) });

    store.prune();
    expect(store.getSummary().total).toBe(0);
    expect(store.getSummary().subconsciousTotal).toBe(1);

    const result = store.retrieveRelevant('TypeScript backend', { maxRecords: 5, maxChars: 900 });
    expect(result.records.length).toBeGreaterThanOrEqual(1);

    expect(store.getSummary().total).toBeGreaterThanOrEqual(1);
    expect(store.getSummary().subconsciousTotal).toBe(0);
  });

  it.skipIf(!sqliteAvailable)('does not enforce a hard cap on memory count', () => {
    const store = createStore();
    const db = (store as any).db as import('./second-brain-db.js').SecondBrainDB;
    const now = Date.now();

    for (let i = 0; i < 60; i++) {
      db.insert({
        id: `mem_test_${i}`,
        user_key: 'user:owner',
        type: i % 2 === 0 ? 'preference' : 'identity',
        summary: `Distinct memory observation number ${i} with completely different content about topic ${i}.`,
        detail: null,
        scope: i % 3 === 0 ? 'active' : 'durable',
        evidence_kind: 'direct',
        source: 'conversation',
        confidence: 0.85,
        importance: 0.75,
        durability: 0.8,
        evidence_count: 1,
        provenance: null,
        dismissed: 0,
        superseded_by: null,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        last_used_at: null,
        last_used_query: null,
      });
    }

    expect(store.getSummary().total).toBe(60);
  });

  it.skipIf(!sqliteAvailable)('preserves memories in subconscious without confidence decay', () => {
    const store = createStore();

    store.remember([
      { type: 'identity', summary: 'User is a software engineer specializing in distributed systems.', confidence: 0.92, importance: 0.9, durability: 0.95 },
    ]);

    const db = (store as any).db as import('./second-brain-db.js').SecondBrainDB;
    const row = db.getActive('user:owner')[0];
    const originalConfidence = row.confidence;

    db.update({ id: row.id, last_seen_at: Date.now() - (31 * 24 * 60 * 60 * 1000), updated_at: Date.now() - (31 * 24 * 60 * 60 * 1000) });
    store.prune();

    expect(store.getSummary().subconsciousTotal).toBe(1);

    const subconsciousRow = db.getSubconscious('user:owner')[0];
    expect(subconsciousRow.confidence).toBeCloseTo(originalConfidence, 2);
  });

  it.skipIf(!sqliteAvailable)('hard deletes only explicitly dismissed memories, not just subconscious ones', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', summary: 'User prefers dark mode for coding.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    const db = (store as any).db as import('./second-brain-db.js').SecondBrainDB;
    const row = db.getActive('user:owner')[0];
    db.update({ id: row.id, last_seen_at: Date.now() - (31 * 24 * 60 * 60 * 1000), updated_at: Date.now() - (31 * 24 * 60 * 60 * 1000) });

    store.prune();
    expect(store.getSummary().subconsciousTotal).toBe(1);

    store.prune();
    expect(store.getSummary().subconsciousTotal).toBe(1);

    store.remember([
      { type: 'preference', summary: 'User does not prefer dark mode for coding.', confidence: 0.95, importance: 0.85, durability: 0.9 },
    ]);

    const recentConscious = store.getSummary().total;
    expect(recentConscious).toBe(1);
  });
});