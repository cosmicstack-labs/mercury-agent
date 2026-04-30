import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { SharedMemoryStore } from './shared-memory-store.js';
import { isSharedMemoryDbAvailable } from './shared-memory-db.js';

const tempDirs: string[] = [];

const sqliteAvailable = isSharedMemoryDbAvailable();

function createStore(): SharedMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sm-'));
  tempDirs.push(dir);
  const config = getDefaultConfig();
  config.memory.sharedMemory = { enabled: true, learningPaused: false };
  const dbPath = join(dir, 'shared-memory', 'shared.db');
  return new SharedMemoryStore(config, dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('SharedMemoryStore', () => {
  it.skipIf(!sqliteAvailable)('stores and retrieves shared memories', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers TypeScript over JavaScript.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    const recent = store.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].summary).toContain('TypeScript');
    expect(recent[0].category).toBe('technical');
  });

  it.skipIf(!sqliteAvailable)('pauses and resumes learning', () => {
    const store = createStore();

    expect(store.isLearningPaused()).toBe(false);

    store.setLearningPaused(true);
    expect(store.isLearningPaused()).toBe(true);

    store.remember([
      { type: 'goal', category: 'professional', summary: 'User wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 },
    ]);
    expect(store.getSummary().total).toBe(0);

    store.setLearningPaused(false);
    expect(store.isLearningPaused()).toBe(false);

    store.remember([
      { type: 'goal', category: 'professional', summary: 'User wants autonomous learning.', confidence: 0.95, importance: 0.92, durability: 0.88 },
    ]);
    expect(store.getSummary().total).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('resolves categories to existing ones', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers dark mode in code editors.', confidence: 0.9, importance: 0.7, durability: 0.85 },
    ]);

    const resolved = store.resolveCategory('tech');
    expect(resolved).toBe('technical');
  });

  it.skipIf(!sqliteAvailable)('creates new categories when no match exists', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'health', summary: 'User exercises every morning before work.', confidence: 0.85, importance: 0.7, durability: 0.8 },
    ]);

    const categories = store.getCategories();
    expect(categories).toContain('health');
  });

  it.skipIf(!sqliteAvailable)('searches memories by query', () => {
    const store = createStore();

    store.remember([
      { type: 'project', category: 'professional', summary: 'User is building a CLI tool for data processing.', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);
    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers Rust for system programming.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    const results = store.search('CLI tool');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain('CLI');
  });

  it.skipIf(!sqliteAvailable)('retrieves relevant memories with context', () => {
    const store = createStore();

    store.remember([
      { type: 'project', category: 'professional', summary: 'User is building Mercury as a personal AI agent.', confidence: 0.95, importance: 0.9, durability: 0.95 },
    ]);

    const result = store.retrieveRelevant('Plan Mercury architecture', { maxRecords: 3, maxChars: 500 });
    expect(result.records).toHaveLength(1);
    expect(result.context).toContain('Mercury');
    expect(result.context).toContain('Shared memory');
  });

  it.skipIf(!sqliteAvailable)('merges similar memories instead of duplicating them', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers concise answers.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers concise technical answers.', confidence: 0.94, importance: 0.81, durability: 0.92 },
    ]);

    const recent = store.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].evidenceCount).toBe(2);
    expect(recent[0].summary).toContain('concise');
  });

  it.skipIf(!sqliteAvailable)('resolves conflicts by confidence', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers concise answers.', confidence: 0.96, importance: 0.84, durability: 0.92 },
    ]);

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User does not prefer concise answers.', confidence: 0.88, importance: 0.82, durability: 0.88 },
    ]);

    const recent = store.getRecent();
    const active = recent.filter(r => !r.dismissed);
    expect(active).toHaveLength(1);
    expect(active[0].summary).toContain('concise answers');
    expect(active[0].summary).not.toContain('does not');
  });

  it.skipIf(!sqliteAvailable)('clears all memories', () => {
    const store = createStore();

    store.remember([
      { type: 'identity', category: 'personal', summary: 'User is a software developer.', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);
    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers dark mode.', confidence: 0.9, importance: 0.75, durability: 0.85 },
    ]);

    expect(store.getSummary().total).toBe(2);

    const cleared = store.clear();
    expect(cleared).toBe(2);
    expect(store.getSummary().total).toBe(0);
  });

  it.skipIf(!sqliteAvailable)('returns summary with categories', () => {
    const store = createStore();

    store.remember([
      { type: 'preference', category: 'technical', summary: 'User prefers TypeScript.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);
    store.remember([
      { type: 'goal', category: 'professional', summary: 'User wants to become a team lead.', confidence: 0.85, importance: 0.9, durability: 0.8 },
    ]);

    const summary = store.getSummary();
    expect(summary.total).toBe(2);
    expect(summary.byCategory.technical).toBe(1);
    expect(summary.byCategory.professional).toBe(1);
    expect(summary.categories).toContain('technical');
    expect(summary.categories).toContain('professional');
  });

  it.skipIf(!sqliteAvailable)('rejects memories below minimum confidence', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', category: 'personal', summary: 'Too uncertain to store.', confidence: 0.3, importance: 0.4, durability: 0.4 },
    ]);

    expect(store.getSummary().total).toBe(0);
  });

  it.skipIf(!sqliteAvailable)('stores weak memories that pass minimum threshold', () => {
    const store = createStore();

    store.remember([
      { type: 'habit', category: 'personal', summary: 'User seems to work on projects late evenings.', confidence: 0.58, importance: 0.6, durability: 0.6 },
    ]);

    expect(store.getSummary().total).toBe(1);
  });

  it('reports better-sqlite3 availability status', () => {
    expect(typeof sqliteAvailable).toBe('boolean');
  });
});