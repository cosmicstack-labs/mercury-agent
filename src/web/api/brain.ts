import { Hono } from 'hono';
import { loadConfig, getMemoryDir } from '../../utils/config.js';
import { isBetterSqlite3Available } from '../../memory/second-brain-db.js';
import { UserMemoryStore } from '../../memory/user-memory.js';
import { join } from 'node:path';

let userMemory: UserMemoryStore | null = null;

export function setUserMemory(mem: UserMemoryStore | null): void {
  userMemory = mem;
}

function ensureMemory(): UserMemoryStore | null {
  if (userMemory) return userMemory;
  if (!isBetterSqlite3Available()) return null;
  try {
    const config = loadConfig();
    const dbPath = join(getMemoryDir(), 'second-brain', 'second-brain.db');
    userMemory = new UserMemoryStore(config, 'user:owner', dbPath);
    return userMemory;
  } catch {
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

const brain = new Hono();

brain.get('/api/brain/stats', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available', total: 0, byType: {}, learningPaused: false });
  }
  return c.json(mem.getSummary());
});

brain.get('/api/brain/memory', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available', memories: [], total: 0 });
  }
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const type = c.req.query('type');
  const query = c.req.query('q');

  let records: any[];
  if (query) {
    records = mem.search(query, limit + offset);
  } else if (type) {
    records = mem.getByType(type as any);
  } else {
    records = mem.getRecent(limit + offset);
  }

  const total = records.length;
  const page = records.slice(offset, offset + limit);

  return c.json({
    memories: page.map(memToJson),
    total,
    limit,
    offset,
  });
});

brain.get('/api/brain/memory/search', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ memories: [], total: 0 });
  }
  const q = c.req.query('q') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const records = mem.search(q, limit);
  return c.json({
    memories: records.map(memToJson),
    total: records.length,
  });
});

brain.get('/api/brain/memory/:id', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available' }, 404);
  }
  const id = c.req.param('id');
  const records = mem.search(id, 1);
  if (!records || records.length === 0) {
    return c.json({ error: 'Memory not found' }, 404);
  }
  return c.json(memToJson(records[0]));
});

brain.delete('/api/brain/memory/:id', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available' }, 400);
  }
  const id = c.req.param('id');
  const deleted = mem.softDeleteMemory(id);
  if (!deleted) {
    return c.json({ error: 'Memory not found' }, 404);
  }
  return c.json({ success: true });
});

brain.put('/api/brain/memory/:id', async (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available' }, 400);
  }
  const id = c.req.param('id');
  const body = await c.req.json();
  const updates: Record<string, any> = {};
  if (body.summary !== undefined) updates.summary = body.summary;
  if (body.detail !== undefined) updates.detail = body.detail;
  if (body.importance !== undefined) updates.importance = Number(body.importance);
  if (body.confidence !== undefined) updates.confidence = Number(body.confidence);
  if (body.scope !== undefined) updates.scope = body.scope;

  const updated = mem.updateMemory(id, updates);
  if (!updated) {
    return c.json({ error: 'Memory not found or update failed' }, 404);
  }
  return c.json({ success: true });
});

brain.post('/api/brain/memory', async (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ error: 'Second brain not available' }, 400);
  }
  const body = await c.req.json();
  if (!body.summary || !body.type) {
    return c.json({ error: 'summary and type are required' }, 400);
  }
  const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode', 'reflection'];
  if (!validTypes.includes(body.type)) {
    return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
  }

  const record = mem.remember([{
    type: body.type,
    summary: body.summary,
    detail: body.detail,
    evidenceKind: 'direct',
    confidence: body.confidence ?? 0.8,
    importance: body.importance ?? 0.7,
    durability: body.durability ?? 0.8,
  }], 'system');

  if (!record || record.length === 0) {
    return c.json({ error: 'Failed to create memory' }, 500);
  }

  const r: any = record[0];
  return c.json(memToJson(r), 201);
});

brain.get('/api/brain/graph', (c) => {
  const mem = ensureMemory();
  if (!mem) {
    return c.json({ nodes: [], edges: [] });
  }

  const records: any[] = mem.getRecent(500);
  const typeColors: Record<string, string> = {
    identity: '#00d4ff',
    preference: '#febc2e',
    goal: '#28c840',
    project: '#a855f7',
    habit: '#f97316',
    decision: '#3b82f6',
    constraint: '#ef4444',
    relationship: '#ec4899',
    episode: '#6366f1',
    reflection: '#14b8a6',
  };

  const nodes = records
    .filter((r: any) => !r.dismissed)
    .map((r: any) => ({
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
        if (overlap >= 2) {
          edges.push({
            source: summaries[i].id,
            target: summaries[j].id,
            type: 'related',
          });
        }
      }
    }
  }

  if (edges.length > 500) {
    edges.length = 500;
  }

  return c.json({ nodes, edges });
});

export default brain;