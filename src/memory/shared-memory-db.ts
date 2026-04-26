import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';

type BetterSqlite3Database = import('better-sqlite3').Database;

const require = createRequire(import.meta.url);

let syncDatabaseClass: typeof import('better-sqlite3') | null = null;
let availabilityChecked = false;
let available = false;

try {
  const mod = require('better-sqlite3');
  const probeDir = join(tmpdir(), `mercury-sqlite3-probe-${process.pid}`);
  try {
    mkdirSync(probeDir, { recursive: true });
    const probeDb = new mod(join(probeDir, 'probe.db'));
    probeDb.close();
    rmSync(probeDir, { recursive: true, force: true });
    syncDatabaseClass = mod;
    available = true;
  } catch {
    syncDatabaseClass = null;
  }
} catch {
  syncDatabaseClass = null;
}

export function isSharedMemoryDbAvailable(): boolean {
  if (!availabilityChecked) {
    availabilityChecked = true;
  }
  return available;
}

export interface SharedMemoryRow {
  id: string;
  user_key: string;
  type: string;
  category: string;
  summary: string;
  detail: string | null;
  scope: string;
  evidence_kind: string;
  source: string;
  confidence: number;
  importance: number;
  durability: number;
  evidence_count: number;
  provenance: string | null;
  dismissed: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  last_used_at: number | null;
  last_used_query: string | null;
}

export interface FriendRow {
  tg_id: string;
  username: string | null;
  first_name: string | null;
  status: 'pending' | 'approved' | 'revoked';
  negative_tags: string | null;
  negative_rules: string | null;
  created_at: number;
  approved_at: number | null;
  query_count_hour: number;
  query_count_reset: number | null;
}

export class SharedMemoryDB {
  private db: BetterSqlite3Database;

  constructor(dbPath: string) {
    if (!syncDatabaseClass) {
      throw new Error(
        'better-sqlite3 is not available — shared memory requires it. ' +
        'Install build tools (make, gcc/g++, python3) or upgrade to Node >= 20.'
      );
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new syncDatabaseClass(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_memories (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        summary TEXT NOT NULL,
        detail TEXT,
        scope TEXT NOT NULL DEFAULT 'durable',
        evidence_kind TEXT NOT NULL DEFAULT 'inferred',
        source TEXT NOT NULL DEFAULT 'conversation',
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        durability REAL NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        provenance TEXT,
        dismissed INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        last_used_query TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS shared_memories_fts USING fts5(
        summary, detail, content=shared_memories, content_rowid=rowid
      );

      CREATE TABLE IF NOT EXISTS shared_memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        tg_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        negative_tags TEXT,
        negative_rules TEXT,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        query_count_hour INTEGER NOT NULL DEFAULT 0,
        query_count_reset INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_shared_memories_user_type ON shared_memories(user_key, type);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_user_dismissed ON shared_memories(user_key, dismissed);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_user_updated ON shared_memories(user_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_user_category ON shared_memories(user_key, category);

      CREATE TRIGGER IF NOT EXISTS shared_memories_ai AFTER INSERT ON shared_memories BEGIN
        INSERT INTO shared_memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;

      CREATE TRIGGER IF NOT EXISTS shared_memories_ad AFTER DELETE ON shared_memories BEGIN
        INSERT INTO shared_memories_fts(shared_memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
      END;

      CREATE TRIGGER IF NOT EXISTS shared_memories_au AFTER UPDATE ON shared_memories BEGIN
        INSERT INTO shared_memories_fts(shared_memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
        INSERT INTO shared_memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;
    `);

    this.db.pragma('foreign_keys = ON');
    logger.info('Shared memory database initialized');
  }

  insert(row: Omit<SharedMemoryRow, 'rowid'> & { rowid?: never }): void {
    const stmt = this.db.prepare(`
      INSERT INTO shared_memories (
        id, user_key, type, category, summary, detail, scope, evidence_kind, source,
        confidence, importance, durability, evidence_count, provenance,
        dismissed, superseded_by, created_at, updated_at,
        last_seen_at, last_used_at, last_used_query
      ) VALUES (
        @id, @user_key, @type, @category, @summary, @detail, @scope, @evidence_kind, @source,
        @confidence, @importance, @durability, @evidence_count, @provenance,
        @dismissed, @superseded_by, @created_at, @updated_at,
        @last_seen_at, @last_used_at, @last_used_query
      )
    `);
    stmt.run({
      id: row.id,
      user_key: row.user_key,
      type: row.type,
      category: row.category ?? 'general',
      summary: row.summary,
      detail: row.detail ?? null,
      scope: row.scope ?? 'durable',
      evidence_kind: row.evidence_kind ?? 'inferred',
      source: row.source ?? 'conversation',
      confidence: row.confidence,
      importance: row.importance,
      durability: row.durability,
      evidence_count: row.evidence_count ?? 1,
      provenance: row.provenance ?? null,
      dismissed: row.dismissed ?? 0,
      superseded_by: row.superseded_by ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_seen_at: row.last_seen_at,
      last_used_at: row.last_used_at ?? null,
      last_used_query: row.last_used_query ?? null,
    });
  }

  update(row: Partial<SharedMemoryRow> & { id: string }): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id: row.id };

    const allowedFields = [
      'category', 'summary', 'detail', 'scope', 'evidence_kind', 'source',
      'confidence', 'importance', 'durability', 'evidence_count',
      'provenance', 'dismissed', 'superseded_by',
      'updated_at', 'last_seen_at', 'last_used_at', 'last_used_query',
    ] as const;

    for (const field of allowedFields) {
      if (row[field] !== undefined) {
        fields.push(`${field} = @${field}`);
        values[field] = row[field];
      }
    }

    if (fields.length === 0) return;

    const stmt = this.db.prepare(`UPDATE shared_memories SET ${fields.join(', ')} WHERE id = @id`);
    stmt.run(values);
  }

  getActive(userKey: string): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE user_key = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(userKey) as SharedMemoryRow[];
  }

  getById(id: string): SharedMemoryRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE id = ?');
    return stmt.get(id) as SharedMemoryRow | undefined;
  }

  getByType(userKey: string, type: string): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE user_key = ? AND type = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(userKey, type) as SharedMemoryRow[];
  }

  getByCategory(userKey: string, category: string): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE user_key = ? AND category = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(userKey, category) as SharedMemoryRow[];
  }

  findMergeCandidate(userKey: string, type: string, normalizedTerms: string[]): SharedMemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM shared_memories WHERE user_key = ? AND type = ? AND dismissed = 0
      AND (summary LIKE ? OR ${normalizedTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likeAny = normalizedTerms.map(t => `%${t}%`);
    const rows = stmt.all(userKey, type, `%${normalizedTerms.slice(0, 3).join('%')}%`, ...likeAny) as SharedMemoryRow[];
    return rows.find(row => !this.rowHasNegationMismatch(row.summary, normalizedTerms));
  }

  findConflictCandidate(userKey: string, type: string, summaryTerms: string[]): SharedMemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM shared_memories WHERE user_key = ? AND type = ? AND dismissed = 0
      AND (${summaryTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likes = summaryTerms.map(t => `%${t}%`);
    const rows = stmt.all(userKey, type, ...likes) as SharedMemoryRow[];
    return rows.find(row => this.rowHasNegationMismatch(row.summary, summaryTerms));
  }

  searchRelevant(userKey: string, query: string, limit: number = 10): SharedMemoryRow[] {
    const tokens = query.split(/\s+/).filter(t => t.length > 0).map(t => t.replace(/"/g, '""'));
    if (tokens.length === 0) {
      const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE user_key = ? AND dismissed = 0 ORDER BY updated_at DESC LIMIT ?');
      return stmt.all(userKey, limit) as SharedMemoryRow[];
    }
    const ftsQuery = tokens.join(' OR ');
    const ftsStmt = this.db.prepare(`
      SELECT m.* FROM shared_memories m
      JOIN shared_memories_fts fts ON m.rowid = fts.rowid
      WHERE shared_memories_fts MATCH ? AND m.user_key = ? AND m.dismissed = 0
      ORDER BY rank
      LIMIT ?
    `);
    try {
      return ftsStmt.all(ftsQuery, userKey, limit) as SharedMemoryRow[];
    } catch {
      const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
      const stmt = this.db.prepare(`SELECT * FROM shared_memories WHERE user_key = ? AND dismissed = 0 AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`);
      const likes = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      return stmt.all(userKey, ...likes, limit) as SharedMemoryRow[];
    }
  }

  searchRelevantForFriend(userKey: string, query: string, negativeTags: string[], limit: number = 10): SharedMemoryRow[] {
    const results = this.searchRelevant(userKey, query, limit * 3);
    if (negativeTags.length === 0) return results.slice(0, limit);
    return results
      .filter(row => !this.matchesNegativeTags(row.category, negativeTags))
      .slice(0, limit);
  }

  private matchesNegativeTags(category: string, negativeTags: string[]): boolean {
    const catLower = category.toLowerCase();
    return negativeTags.some(tag => {
      const tagLower = tag.toLowerCase();
      return catLower === tagLower || catLower.includes(tagLower) || tagLower.includes(catLower);
    });
  }

  softDelete(id: string): boolean {
    const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE id = ?');
    const result = stmt.run(Date.now(), id);
    return result.changes > 0;
  }

  clearByType(userKey: string, type?: string): number {
    if (type) {
      const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE user_key = ? AND type = ? AND dismissed = 0');
      const result = stmt.run(Date.now(), userKey, type);
      return result.changes;
    }
    const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE user_key = ? AND dismissed = 0');
    const result = stmt.run(Date.now(), userKey);
    return result.changes;
  }

  totalActive(userKey: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM shared_memories WHERE user_key = ? AND dismissed = 0');
    const row = stmt.get(userKey) as { count: number };
    return row.count;
  }

  countByType(userKey: string): Record<string, number> {
    const stmt = this.db.prepare("SELECT type, COUNT(*) as count FROM shared_memories WHERE user_key = ? AND dismissed = 0 GROUP BY type");
    const rows = stmt.all(userKey) as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  getCategories(userKey: string): string[] {
    const raw = this.getMeta('categories');
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  addCategory(userKey: string, category: string): void {
    const existing = this.getCategories(userKey);
    if (!existing.includes(category)) {
      existing.push(category);
      this.setMeta('categories', JSON.stringify(existing));
    }
  }

  findBestCategoryMatch(userKey: string, candidateCategory: string): string | null {
    const existing = this.getCategories(userKey);
    if (existing.length === 0) return null;

    const candidateLower = candidateCategory.toLowerCase();
    const candidateTerms = candidateLower.split(/[^a-z0-9]+/).filter(t => t.length > 2);

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const cat of existing) {
      const catLower = cat.toLowerCase();
      const catTerms = catLower.split(/[^a-z0-9]+/).filter(t => t.length > 2);

      if (catLower === candidateLower) return cat;

      let overlap = 0;
      for (const term of candidateTerms) {
        if (catTerms.some(ct => ct === term || ct.includes(term) || term.includes(ct))) {
          overlap++;
        }
      }
      const score = overlap / Math.max(candidateTerms.length, 1);
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestMatch = cat;
      }
    }

    return bestMatch;
  }

  getFriends(): FriendRow[] {
    const stmt = this.db.prepare('SELECT * FROM friends ORDER BY created_at DESC');
    return stmt.all() as FriendRow[];
  }

  getFriend(tgId: string): FriendRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM friends WHERE tg_id = ?');
    return stmt.get(tgId) as FriendRow | undefined;
  }

  getFriendsByStatus(status: FriendRow['status']): FriendRow[] {
    const stmt = this.db.prepare('SELECT * FROM friends WHERE status = ? ORDER BY created_at DESC');
    return stmt.all(status) as FriendRow[];
  }

  addFriend(friend: Omit<FriendRow, 'query_count_hour'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO friends (tg_id, username, first_name, status, negative_tags, negative_rules, created_at, approved_at, query_count_hour, query_count_reset)
      VALUES (@tg_id, @username, @first_name, @status, @negative_tags, @negative_rules, @created_at, @approved_at, 0, @query_count_reset)
    `);
    stmt.run({
      tg_id: friend.tg_id,
      username: friend.username ?? null,
      first_name: friend.first_name ?? null,
      status: friend.status,
      negative_tags: friend.negative_tags ?? null,
      negative_rules: friend.negative_rules ?? null,
      created_at: friend.created_at,
      approved_at: friend.approved_at ?? null,
      query_count_reset: Date.now(),
    });
  }

  updateFriend(tgId: string, updates: Partial<Pick<FriendRow, 'status' | 'username' | 'first_name' | 'negative_tags' | 'negative_rules' | 'approved_at'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { tg_id: tgId };

    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;
    }
    if (updates.username !== undefined) {
      fields.push('username = @username');
      values.username = updates.username;
    }
    if (updates.first_name !== undefined) {
      fields.push('first_name = @first_name');
      values.first_name = updates.first_name;
    }
    if (updates.negative_tags !== undefined) {
      fields.push('negative_tags = @negative_tags');
      values.negative_tags = updates.negative_tags;
    }
    if (updates.negative_rules !== undefined) {
      fields.push('negative_rules = @negative_rules');
      values.negative_rules = updates.negative_rules;
    }
    if (updates.approved_at !== undefined) {
      fields.push('approved_at = @approved_at');
      values.approved_at = updates.approved_at;
    }

    if (fields.length === 0) return;

    const stmt = this.db.prepare(`UPDATE friends SET ${fields.join(', ')} WHERE tg_id = @tg_id`);
    stmt.run(values);
  }

  removeFriend(tgId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM friends WHERE tg_id = ?');
    const result = stmt.run(tgId);
    return result.changes > 0;
  }

  incrementFriendQueryCount(tgId: string): number {
    const friend = this.getFriend(tgId);
    if (!friend) return -1;

    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let count = friend.query_count_hour;
    let resetTime = friend.query_count_reset ?? now;

    if (now - resetTime >= oneHour) {
      count = 0;
      resetTime = now;
    }

    count += 1;

    const stmt = this.db.prepare('UPDATE friends SET query_count_hour = @count, query_count_reset = @resetTime WHERE tg_id = @tg_id');
    stmt.run({ count, resetTime, tg_id: tgId });

    return count;
  }

  setMeta(key: string, value: string): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO shared_memory_meta (key, value) VALUES (@key, @value)');
    stmt.run({ key, value });
  }

  getMeta(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM shared_memory_meta WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteMeta(key: string): void {
    const stmt = this.db.prepare('DELETE FROM shared_memory_meta WHERE key = ?');
    stmt.run(key);
  }

  private rowHasNegationMismatch(existingSummary: string, incomingTerms: string[]): boolean {
    const lower = existingSummary.toLowerCase();
    const negationWords = ['not', 'never', 'no longer', 'avoid', 'against', 'disabled'];
    const hasNegation = negationWords.some(w => lower.includes(w));
    const incomingLower = incomingTerms.join(' ');
    const incomingHasNegation = negationWords.some(w => incomingLower.includes(w));
    return hasNegation !== incomingHasNegation;
  }

  close(): void {
    this.db.close();
  }
}