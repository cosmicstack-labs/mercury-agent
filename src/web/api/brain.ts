import { Hono } from 'hono';
import { loadConfig, getMemoryDir, saveConfig } from '../../utils/config.js';
import { isBetterSqlite3Available } from '../../memory/second-brain-db.js';
import { UserMemoryStore } from '../../memory/user-memory.js';
import type { Belief, BeliefKind, BeliefStatus, BeliefStore, Evidence } from '../../memory/beliefs.js';
import { join } from 'node:path';

let userMemory: UserMemoryStore | null = null;

const SQLITE_DEPENDENCY_ERROR =
  'Second brain dependency issue: better-sqlite3 (SQLite backend) is not available. Install dependencies and restart Mercury.';

export function setUserMemory(mem: UserMemoryStore | null): void {
  userMemory = mem;
}

function ensureMemory(): UserMemoryStore | null {
  if (userMemory) return userMemory;

  // Fallback: try to create our own store if the main agent didn't provide one.
  // This can fail if better-sqlite3 isn't available or the DB doesn't exist yet.
  if (!isBetterSqlite3Available()) return null;
  try {
    const config = loadConfig();
    const dbPath = join(getMemoryDir(), 'second-brain', 'second-brain.db');
    userMemory = new UserMemoryStore(config, 'user:owner', dbPath);
    return userMemory;
  } catch (err) {
    console.error('[Mercury Web] Second Brain fallback init failed:', err);
    return null;
  }
}

function memToJson(r: any) {
  return {
    id: r.id,
    type: r.type,
    summary: r.summary,
    detail: r.detail || null,
    scope: r.scope,
    evidenceKind: r.evidenceKind,
    source: r.source,
    confidence: r.confidence,
    importance: r.importance,
    durability: r.durability,
    evidenceCount: r.evidenceCount,
    dismissed: r.dismissed,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastSeenAt: r.lastSeenAt,
  };
}

function personToJson(p: any) {
  return {
    id: p.id,
    name: p.name,
    canonicalName: p.canonicalName,
    relationship: p.relationshipToUser ?? undefined,
    summary: p.description ?? undefined,
    traits: p.traits ?? [],
    confidence: p.confidence,
    memoryCount: p.memoryCount,
    firstSeenAt: p.firstSeenAt,
    lastSeenAt: p.lastSeenAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    connections: p.connections ?? [],
  };
}

const brain = new Hono();

brain.get('/api/brain/status', async (c) => {
  const mem = ensureMemory();
  if (mem) {
    return c.json({ ...mem.getSummary(), available: true, shareLearning: mem.isShareLearning(), shareableCount: mem.countShareable() });
  }
  return c.json({ total: 0, byType: {}, learningPaused: false, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
});

// Toggle shared learning — when on, new memories extracted via remember() are
// marked shareable so the cloud fetch can pull them into the collaborative pool.
brain.post('/api/brain/shared-learning', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const body = await c.req.json().catch(() => ({}));
  const enabled = Boolean(body.enabled);
  mem.setShareLearning(enabled);

  // Persist to config so it survives restarts.
  try {
    const config = loadConfig();
    if (!config.memory.collaborativeKnowledge) config.memory.collaborativeKnowledge = {};
    config.memory.collaborativeKnowledge.shareLearning = enabled;
    saveConfig(config);
  } catch { /* best-effort — in-memory toggle still works */ }

  return c.json({ shareLearning: enabled, shareableCount: mem.countShareable() });
});

brain.get('/api/brain/shared-learning', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  return c.json({ shareLearning: mem.isShareLearning(), shareableCount: mem.countShareable() });
});

brain.get('/api/brain/memory', async (c) => {
  const mem = ensureMemory();
  if (mem) {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = parseInt(c.req.query('offset') || '0');
    const type = c.req.query('type');
    const query = c.req.query('q');
    const scope = c.req.query('scope') || 'conscious';

    let records: any[];
    if (query) {
      records = scope === 'all' ? mem.searchAll(query, limit + offset) : mem.search(query, limit + offset);
    } else if (scope === 'subconscious') {
      records = mem.getSubconscious(limit + offset);
    } else if (type) {
      records = mem.getByType(type as any);
    } else {
      records = mem.getRecent(limit + offset);
    }

    const total = records.length;
    const page = records.slice(offset, offset + limit);
    return c.json({ memories: page.map(memToJson), total, limit, offset, available: true });
  }

  return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
});

brain.get('/api/brain/memory/search', async (c) => {
  const mem = ensureMemory();
  if (mem) {
    const q = c.req.query('q') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
    const scope = c.req.query('scope') || 'all';
    const records = scope === 'all' ? mem.searchAll(q, limit) : mem.search(q, limit);
    return c.json({ memories: records.map(memToJson), total: records.length, available: true });
  }
  return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
});

brain.get('/api/brain/memory/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const id = c.req.param('id');
  const record = mem.getById(id);
  if (!record) return c.json({ error: 'Memory not found' }, 404);
  return c.json({ ...memToJson(record), available: true });
});

brain.delete('/api/brain/memory/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const id = c.req.param('id');
  const deleted = mem.softDeleteMemory(id);
  if (!deleted) return c.json({ error: 'Memory not found' }, 404);
  return c.json({ success: true });
});

brain.put('/api/brain/memory/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const id = c.req.param('id');
  const body = await c.req.json();
  const updates: Record<string, any> = {};
  if (body.summary !== undefined) updates.summary = body.summary;
  if (body.detail !== undefined) updates.detail = body.detail;
  if (body.importance !== undefined) updates.importance = Number(body.importance);
  if (body.confidence !== undefined) updates.confidence = Number(body.confidence);
  const updated = mem.updateMemory(id, updates);
  if (!updated) return c.json({ error: 'Memory not found or update failed' }, 404);
  return c.json({ success: true });
});

brain.post('/api/brain/memory', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const body = await c.req.json();
  if (!body.summary || !body.type) return c.json({ error: 'summary and type are required' }, 400);
  const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode', 'reflection'];
  if (!validTypes.includes(body.type)) return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);

  const record = mem.remember([{
    type: body.type,
    summary: body.summary,
    detail: body.detail,
    evidenceKind: 'direct',
    confidence: body.confidence ?? 0.8,
    importance: body.importance ?? 0.7,
    durability: body.durability ?? 0.8,
  }], 'system');

  if (!record || record.length === 0) return c.json({ error: 'Failed to create memory' }, 500);
  return c.json(memToJson(record[0]), 201);
});

brain.get('/api/brain/persons', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ persons: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const q = c.req.query('q') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 200);
  const persons = mem.listPersons(q, limit);
  return c.json({ persons: persons.map(personToJson), total: persons.length, available: true });
});

brain.get('/api/brain/persons/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const id = c.req.param('id');
  const person = mem.getPerson(id);
  if (!person) return c.json({ error: 'Person not found' }, 404);
  return c.json({ person: personToJson(person), available: true });
});

brain.get('/api/brain/persons/:id/memories', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const id = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const memories = mem.getPersonMemories(id, limit);
  return c.json({ memories: memories.map(memToJson), total: memories.length, available: true });
});

brain.get('/api/brain/graph', async (c) => {
  const mem = ensureMemory();
  if (mem) {
    const typeColors: Record<string, string> = {
      identity: '#00d4ff', preference: '#febc2e', goal: '#28c840', project: '#a855f7',
      habit: '#f97316', decision: '#3b82f6', constraint: '#ef4444', relationship: '#ec4899',
      episode: '#6366f1', reflection: '#14b8a6',
    };

    const records: any[] = mem.getRecent(500);
    const nodes = records.filter((r: any) => !r.dismissed).map((r: any) => ({
      id: r.id,
      label: r.summary.length > 60 ? r.summary.slice(0, 57) + '...' : r.summary,
      fullLabel: r.summary,
      type: r.type,
      importance: r.importance,
      confidence: r.confidence,
      color: typeColors[r.type] || '#888888',
      size: Math.max(4, r.importance * 12),
    }));

    const edges: Array<{ source: string; target: string; type: string }> = [];
    if (records.length <= 200) {
      const summaries = records.filter((r: any) => !r.dismissed).map((r: any) => ({
        id: r.id,
        words: r.summary.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3),
        type: r.type,
      }));
      for (let i = 0; i < summaries.length; i++) {
        for (let j = i + 1; j < summaries.length; j++) {
          const overlap = summaries[i].words.filter((w: string) => summaries[j].words.includes(w)).length;
          if (overlap >= 2) edges.push({ source: summaries[i].id, target: summaries[j].id, type: 'related' });
        }
      }
    }
    if (edges.length > 500) edges.length = 500;
    return c.json({ nodes, edges, available: true });
  }

  return c.json({ nodes: [], edges: [], available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
});

// ── Owner Model (ADR-026): beliefs, the review queue and the quarantine ───

const BELIEF_STATUSES: BeliefStatus[] = ['candidate', 'held', 'confirmed', 'contested', 'retired', 'forgotten'];
const BELIEF_KINDS: BeliefKind[] = ['fact', 'preference', 'trait', 'situation', 'relationship', 'goal', 'project', 'episode'];

function beliefToJson(store: BeliefStore, b: Belief, now = Date.now()) {
  return { ...b, confidence: Number(store.confidence(b, now).toFixed(3)) };
}

function evidenceToJson(e: Evidence) {
  return { id: e.id, kind: e.kind, excerpt: e.excerpt, weight: e.weight, at: e.at, sessionId: e.sessionId, turnRef: e.turnRef };
}

/** `?status=held,confirmed` → ['held','confirmed'], unknown values dropped; undefined when absent. */
function parseList<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const picked = raw.split(',').map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s));
  return picked.length > 0 ? picked : undefined;
}

brain.get('/api/brain/beliefs', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ beliefs: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const store = mem.beliefs;
  const statuses = parseList(c.req.query('status'), BELIEF_STATUSES);
  const kinds = parseList(c.req.query('kind'), BELIEF_KINDS);
  const dimension = c.req.query('dimension') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '200'), 1000);
  const now = Date.now();
  const beliefs = store.list({ statuses, kinds, dimension, limit }).map((b) => beliefToJson(store, b, now));
  return c.json({ beliefs, total: beliefs.length, counts: store.counts(), available: true });
});

brain.get('/api/brain/beliefs/learned', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ beliefs: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const store = mem.beliefs;
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7') || 7, 1), 365);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 500);
  const now = Date.now();
  const beliefs = store.recentlyLearned(now - days * 86_400_000, limit).map((b) => ({
    ...beliefToJson(store, b, now),
    evidence: store.evidenceFor(b.id, 1).map(evidenceToJson),
  }));
  return c.json({ beliefs, total: beliefs.length, days, available: true });
});

brain.get('/api/brain/beliefs/contested', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ pairs: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const store = mem.beliefs;
  const now = Date.now();
  const pairs = store.contested().map(({ a, b }) => ({ a: beliefToJson(store, a, now), b: b ? beliefToJson(store, b, now) : null }));
  return c.json({ pairs, total: pairs.length, available: true });
});

brain.post('/api/brain/beliefs/settle', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const body = await c.req.json().catch(() => ({}));
  const winnerId = typeof body.winnerId === 'string' ? body.winnerId : '';
  const loserId = typeof body.loserId === 'string' ? body.loserId : '';
  if (!winnerId || !loserId || winnerId === loserId) return c.json({ error: 'winnerId and loserId are required and must differ' }, 400);
  const store = mem.beliefs;
  const winner = store.get(winnerId);
  if (!winner || winner.status === 'forgotten') return c.json({ error: 'Winner not found' }, 404);
  if (!store.get(loserId)) return c.json({ error: 'Loser not found' }, 404);
  store.settle(winnerId, loserId);
  return c.json({ success: true, winner: beliefToJson(store, store.get(winnerId)!), loser: beliefToJson(store, store.get(loserId)!) });
});

brain.get('/api/brain/beliefs/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const store = mem.beliefs;
  const b = store.get(c.req.param('id'));
  if (!b) return c.json({ error: 'Belief not found' }, 404);
  return c.json({ ...beliefToJson(store, b), evidence: store.evidenceFor(b.id, 50).map(evidenceToJson), available: true });
});

brain.post('/api/brain/beliefs/:id/confirm', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const store = mem.beliefs;
  const b = store.confirm(c.req.param('id'));
  if (!b) return c.json({ error: 'Belief not found' }, 404);
  return c.json({ success: true, belief: beliefToJson(store, b) });
});

brain.post('/api/brain/beliefs/:id/forget', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const store = mem.beliefs;
  const id = c.req.param('id');
  const before = store.get(id);
  if (!before) return c.json({ error: 'Belief not found' }, 404);
  store.forget(id);
  return c.json({ success: true, forgotten: before.statement });
});

brain.post('/api/brain/beliefs/:id/correct', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const body = await c.req.json().catch(() => ({}));
  const statement = typeof body.statement === 'string' ? body.statement.trim() : '';
  if (statement.length < 3) return c.json({ error: 'statement is required' }, 400);
  const store = mem.beliefs;
  const id = c.req.param('id');
  const before = store.get(id);
  if (!before || before.status === 'forgotten') return c.json({ error: 'Belief not found' }, 404);
  const result = store.apply({ op: 'correction', beliefId: id, statement, excerpt: statement, evidenceKind: 'owner' });
  if (!result) return c.json({ error: 'Correction failed' }, 500);
  return c.json({ success: true, replaced: beliefToJson(store, result.replaced ?? before), belief: beliefToJson(store, result.belief) });
});

// Legacy rows the migration set aside (scope = 'quarantine'); never deleted, restorable.
brain.get('/api/brain/quarantine', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const limit = Math.min(parseInt(c.req.query('limit') || '200'), 1000);
  const memories = mem.listQuarantined(limit).map(memToJson);
  return c.json({ memories, total: memories.length, available: true });
});

brain.post('/api/brain/quarantine/:id/restore', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const id = c.req.param('id');
  const beliefId = mem.restoreQuarantined(id);
  if (!beliefId) return c.json({ error: 'Quarantined memory not found' }, 404);
  const restored = mem.getById(beliefId);
  return c.json({ success: true, memory: restored ? memToJson(restored) : null });
});

export default brain;
