import { Hono } from 'hono';
import { loadConfig, getMemoryDir } from '../../utils/config.js';
import { isSharedMemoryDbAvailable } from '../../memory/shared-memory-db.js';
import { SharedMemoryStore } from '../../memory/shared-memory-store.js';
import { RelayClient } from '../../relay/client.js';
import { join } from 'node:path';

let sharedMemory: SharedMemoryStore | null = null;
let relayClient: RelayClient | null = null;

const SQLITE_DEPENDENCY_ERROR =
  'Shared memory dependency issue: better-sqlite3 (SQLite backend) is not available. Install dependencies and restart Mercury.';

export function setSharedMemory(mem: SharedMemoryStore | null): void {
  sharedMemory = mem;
}

export function setRelayClient(client: RelayClient | null): void {
  relayClient = client;
}

function ensureMemory(): SharedMemoryStore | null {
  if (sharedMemory) return sharedMemory;

  if (!isSharedMemoryDbAvailable()) return null;
  try {
    const config = loadConfig();
    const dbPath = join(getMemoryDir(), 'shared', 'shared.db');
    sharedMemory = new SharedMemoryStore(config, dbPath);
    return sharedMemory;
  } catch (err) {
    console.error('[Mercury Web] Shared Memory fallback init failed:', err);
    return null;
  }
}

function memToJson(r: any) {
  return {
    id: r.id,
    type: r.type,
    category: r.category,
    summary: r.summary,
    detail: r.detail || null,
    evidenceKind: r.evidenceKind,
    confidence: r.confidence,
    importance: r.importance,
    durability: r.durability,
    evidenceCount: r.evidenceCount,
    dismissed: r.dismissed,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastSeenAt: r.lastSeenAt,
    lastUsedAt: r.lastUsedAt || null,
    lastUsedQuery: r.lastUsedQuery || null,
  };
}

const sharedMemoryRoutes = new Hono();

// ══════════════════════════════════════════════════════════════
// Shared Memory endpoints
// ══════════════════════════════════════════════════════════════

// ── Status / Summary ──
sharedMemoryRoutes.get('/api/shared-memory/status', async (c) => {
  const mem = ensureMemory();
  if (mem) {
    return c.json({ ...mem.getSummary(), available: true });
  }
  return c.json({ total: 0, byType: {}, byCategory: {}, categories: [], learningPaused: false, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
});

// ── List / Search memories ──
sharedMemoryRoutes.get('/api/shared-memory/memories', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const query = c.req.query('q');

  let records: any[];
  if (query) {
    records = mem.search(query, limit + offset);
  } else {
    records = mem.getRecent(limit + offset);
  }

  const total = records.length;
  const page = records.slice(offset, offset + limit);
  return c.json({ memories: page.map(memToJson), total, limit, offset, available: true });
});

// ── Search ──
sharedMemoryRoutes.get('/api/shared-memory/memories/search', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ memories: [], total: 0, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);

  const q = c.req.query('q') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const records = mem.search(q, limit);
  return c.json({ memories: records.map(memToJson), total: records.length, available: true });
});

// ── Create memory ──
sharedMemoryRoutes.post('/api/shared-memory/memories', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);

  const body = await c.req.json();
  if (!body.summary || !body.type) return c.json({ error: 'summary and type are required' }, 400);

  const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode'];
  if (!validTypes.includes(body.type)) return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);

  const record = mem.manualInsert({
    type: body.type,
    category: body.category || 'general',
    summary: body.summary,
    detail: body.detail,
    evidenceKind: 'direct',
    confidence: body.confidence ?? 0.8,
    importance: body.importance ?? 0.7,
    durability: body.durability ?? 0.8,
  });

  if (!record) return c.json({ error: 'Failed to create memory' }, 500);
  return c.json(memToJson(record), 201);
});

// ── Learning pause/resume ──
sharedMemoryRoutes.get('/api/shared-memory/learning', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  return c.json({ paused: mem.isLearningPaused() });
});

sharedMemoryRoutes.put('/api/shared-memory/learning', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const body = await c.req.json();
  if (typeof body.paused !== 'boolean') return c.json({ error: 'paused (boolean) is required' }, 400);
  mem.setLearningPaused(body.paused);
  return c.json({ paused: mem.isLearningPaused() });
});

// ── Categories ──
sharedMemoryRoutes.get('/api/shared-memory/categories', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ categories: [], available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  const categories = mem.getCategories();
  const summary = mem.getSummary();
  return c.json({ categories, byCategory: summary.byCategory, available: true });
});

// ── Clear all shared memories ──
sharedMemoryRoutes.delete('/api/shared-memory/memories', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const deleted = mem.clear();
  return c.json({ success: true, deleted });
});

// ══════════════════════════════════════════════════════════════
// Friend Access Control endpoints
// ══════════════════════════════════════════════════════════════

sharedMemoryRoutes.get('/api/shared-memory/access', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ accessMap: {}, available: false, error: SQLITE_DEPENDENCY_ERROR }, 503);
  return c.json({ accessMap: mem.getFriendAccessMap(), available: true });
});

sharedMemoryRoutes.get('/api/shared-memory/access/:friend', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const friend = c.req.param('friend');
  const categories = mem.getAllowedCategories(friend);
  return c.json({ friend, categories });
});

sharedMemoryRoutes.put('/api/shared-memory/access/:friend', async (c) => {
  const mem = ensureMemory();
  if (!mem) return c.json({ error: SQLITE_DEPENDENCY_ERROR, available: false }, 503);
  const friend = c.req.param('friend');
  const body = await c.req.json();

  if (body.action === 'grant' && body.category) {
    mem.grantCategory(friend, body.category);
  } else if (body.action === 'grant-all') {
    mem.grantAllCategories(friend);
  } else if (body.action === 'revoke' && body.category) {
    mem.revokeCategory(friend, body.category);
  } else if (body.action === 'revoke-all') {
    mem.revokeAllCategories(friend);
  } else if (body.action === 'set' && Array.isArray(body.categories)) {
    mem.revokeAllCategories(friend);
    for (const cat of body.categories) {
      mem.grantCategory(friend, cat);
    }
  } else {
    return c.json({ error: 'Invalid action. Use grant, grant-all, revoke, revoke-all, or set' }, 400);
  }

  return c.json({ friend, categories: mem.getAllowedCategories(friend) });
});

// ══════════════════════════════════════════════════════════════
// Friend Management endpoints (via RelayClient)
// ══════════════════════════════════════════════════════════════

// ── List friends (confirmed + pending) ──
sharedMemoryRoutes.get('/api/friends', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured. Set up relay in mercury doctor.', available: false }, 503);
  try {
    const data = await relayClient.getFriends();
    return c.json({ ...data, available: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to fetch friends', available: false }, 500);
  }
});

// ── Send friend request ──
sharedMemoryRoutes.post('/api/friends/request', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const body = await c.req.json();
  const username = body.username?.trim()?.toLowerCase();
  if (!username) return c.json({ error: 'username is required' }, 400);
  try {
    const result = await relayClient.sendFriendRequest(username);
    return c.json({ ...result, success: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to send friend request' }, 400);
  }
});

// ── Accept friend request ──
sharedMemoryRoutes.post('/api/friends/accept', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const body = await c.req.json();
  const username = body.username?.trim()?.toLowerCase();
  if (!username) return c.json({ error: 'username is required' }, 400);
  try {
    const result = await relayClient.approveRequest(username);
    return c.json({ ...result, success: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to accept request' }, 400);
  }
});

// ── Reject friend request ──
sharedMemoryRoutes.post('/api/friends/reject', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const body = await c.req.json();
  const username = body.username?.trim()?.toLowerCase();
  if (!username) return c.json({ error: 'username is required' }, 400);
  try {
    const result = await relayClient.rejectRequest(username);
    return c.json({ ...result, success: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to reject request' }, 400);
  }
});

// ── Cancel sent friend request ──
sharedMemoryRoutes.post('/api/friends/cancel', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const body = await c.req.json();
  const username = body.username?.trim()?.toLowerCase();
  if (!username) return c.json({ error: 'username is required' }, 400);
  try {
    const result = await relayClient.cancelRequest(username);
    return c.json({ ...result, success: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to cancel request' }, 400);
  }
});

// ── Remove friend ──
sharedMemoryRoutes.delete('/api/friends/:username', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const username = c.req.param('username');
  try {
    const result = await relayClient.deleteFriend(username);
    return c.json({ ...result, success: true });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to remove friend' }, 400);
  }
});

// ── Check user online status ──
sharedMemoryRoutes.get('/api/friends/:username/status', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const username = c.req.param('username');
  try {
    const result = await relayClient.getUserStatus(username);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to check status' }, 500);
  }
});

// ── Query friend's shared memory ──
sharedMemoryRoutes.post('/api/friends/:username/query', async (c) => {
  if (!relayClient) return c.json({ error: 'Relay not configured', available: false }, 503);
  const username = c.req.param('username');
  const body = await c.req.json();
  const query = body.query?.trim();
  if (!query) return c.json({ error: 'query is required' }, 400);
  try {
    const result = await relayClient.sendMemoryQuery(username, query);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to send memory query' }, 500);
  }
});

export default sharedMemoryRoutes;
