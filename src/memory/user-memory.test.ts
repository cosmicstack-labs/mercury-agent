import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { UserMemoryStore } from './user-memory.js';

const tempDirs: string[] = [];

function createStore(): UserMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sb-'));
  tempDirs.push(dir);
  const config = getDefaultConfig();
  config.memory.secondBrain = { enabled: true, maxRecords: 50 };
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
  it('merges similar durable memories instead of duplicating them', () => {
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

  it('retrieves only relevant records for a query', () => {
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

  it('auto-resolves conflicts by dismissing the lower-confidence memory', () => {
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

  it('auto-resolves conflicts when incoming has higher confidence', () => {
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

  it('synthesizes a compact profile and reflection records from repeated signal', () => {
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

  it('separates active state from durable profile', () => {
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

  it('supports pause and resume of learning', () => {
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

  it('clears all memories', () => {
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

  it('full-text search finds relevant memories', () => {
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

  it('deprioritizes stale inferred memories in retrieval', () => {
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

  it('stores weak memories that pass minimum threshold', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', summary: 'User seems to work on projects late evenings.', confidence: 0.58, importance: 0.6, durability: 0.6, evidenceKind: 'inferred' },
    ]);

    expect(store.getSummary().total).toBe(1);
  });

  it('rejects memories below minimum confidence', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', summary: 'Too uncertain to store.', confidence: 0.3, importance: 0.4, durability: 0.4 },
    ]);

    expect(store.getSummary().total).toBe(0);
  });
});