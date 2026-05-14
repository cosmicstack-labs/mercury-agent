import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';

type BetterSqlite3Database = import('better-sqlite3').Database;

const require = createRequire(import.meta.url);

let syncDatabaseClass: typeof import('better-sqlite3') | null = null;

try {
  const mod = require('better-sqlite3');
  const probeDir = join(tmpdir(), `mercury-sqlite3-probe-${process.pid}`);
  try {
    mkdirSync(probeDir, { recursive: true });
    const probeDb = new mod(join(probeDir, 'probe.db'));
    probeDb.close();
    rmSync(probeDir, { recursive: true, force: true });
    syncDatabaseClass = mod;
  } catch {
    syncDatabaseClass = null;
  }
} catch {
  syncDatabaseClass = null;
}

export function isSharedMemoryDbAvailable(): boolean {
  return syncDatabaseClass !== null;
}

export interface SharedMemoryRow {
  id: string;
  type: string;
  category: string;
  summary: string;
  detail: string | null;
  evidence_kind: string;
  confidence: number;
  importance: number;
  durability: number;
  evidence_count: number;
  dismissed: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  last_used_at: number | null;
  last_used_query: string | null;
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
        type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        summary TEXT NOT NULL,
        detail TEXT,
        evidence_kind TEXT NOT NULL DEFAULT 'inferred',
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        durability REAL NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        dismissed INTEGER NOT NULL DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS idx_shared_memories_type ON shared_memories(type);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_dismissed ON shared_memories(dismissed);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_updated ON shared_memories(updated_at);
      CREATE INDEX IF NOT EXISTS idx_shared_memories_category ON shared_memories(category);

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
    this.initFriendAccess();
    logger.info('Shared memory database initialized');
  }

  // --- Friend Access Control ---

  private initFriendAccess(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friend_access (
        friend_username TEXT NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (friend_username, category)
      );
    `);
  }

  getAllowedCategories(friend: string): string[] {
    const rows = this.db.prepare(
      'SELECT category FROM friend_access WHERE friend_username = ?'
    ).all(friend) as { category: string }[];
    return rows.map(r => r.category);
  }

  grantCategory(friend: string, category: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO friend_access (friend_username, category) VALUES (?, ?)'
    ).run(friend, category);
  }

  revokeCategory(friend: string, category: string): void {
    this.db.prepare(
      'DELETE FROM friend_access WHERE friend_username = ? AND category = ?'
    ).run(friend, category);
  }

  grantAllCategories(friend: string, categories: string[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO friend_access (friend_username, category) VALUES (?, ?)'
    );
    const tx = this.db.transaction((cats: string[]) => {
      for (const cat of cats) {
        insert.run(friend, cat);
      }
    });
    tx(categories);
  }

  revokeAllCategories(friend: string): void {
    this.db.prepare('DELETE FROM friend_access WHERE friend_username = ?').run(friend);
  }

  getFriendAccessMap(): Record<string, string[]> {
    const rows = this.db.prepare(
      'SELECT friend_username, category FROM friend_access ORDER BY friend_username'
    ).all() as { friend_username: string; category: string }[];
    const map: Record<string, string[]> = {};
    for (const r of rows) {
      if (!map[r.friend_username]) map[r.friend_username] = [];
      map[r.friend_username].push(r.category);
    }
    return map;
  }

  insert(row: Omit<SharedMemoryRow, 'rowid'> & { rowid?: never }): void {
    const stmt = this.db.prepare(`
      INSERT INTO shared_memories (
        id, type, category, summary, detail, evidence_kind,
        confidence, importance, durability, evidence_count,
        dismissed, created_at, updated_at,
        last_seen_at, last_used_at, last_used_query
      ) VALUES (
        @id, @type, @category, @summary, @detail, @evidence_kind,
        @confidence, @importance, @durability, @evidence_count,
        @dismissed, @created_at, @updated_at,
        @last_seen_at, @last_used_at, @last_used_query
      )
    `);
    stmt.run({
      id: row.id,
      type: row.type,
      category: row.category ?? 'general',
      summary: row.summary,
      detail: row.detail ?? null,
      evidence_kind: row.evidence_kind ?? 'inferred',
      confidence: row.confidence,
      importance: row.importance,
      durability: row.durability,
      evidence_count: row.evidence_count ?? 1,
      dismissed: row.dismissed ?? 0,
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
      'category', 'summary', 'detail', 'evidence_kind',
      'confidence', 'importance', 'durability', 'evidence_count',
      'dismissed',
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

  getActive(): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all() as SharedMemoryRow[];
  }

  getById(id: string): SharedMemoryRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE id = ?');
    return stmt.get(id) as SharedMemoryRow | undefined;
  }

  getByType(type: string): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE type = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(type) as SharedMemoryRow[];
  }

  getByCategory(category: string): SharedMemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE category = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(category) as SharedMemoryRow[];
  }

  findMergeCandidate(type: string, normalizedTerms: string[]): SharedMemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM shared_memories WHERE type = ? AND dismissed = 0
      AND (summary LIKE ? OR ${normalizedTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likeAny = normalizedTerms.map(t => `%${t}%`);
    const rows = stmt.all(type, `%${normalizedTerms.slice(0, 3).join('%')}%`, ...likeAny) as SharedMemoryRow[];
    return rows.find(row => !this.rowHasNegationMismatch(row.summary, normalizedTerms));
  }

  findConflictCandidate(type: string, summaryTerms: string[]): SharedMemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM shared_memories WHERE type = ? AND dismissed = 0
      AND (${summaryTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likes = summaryTerms.map(t => `%${t}%`);
    const rows = stmt.all(type, ...likes) as SharedMemoryRow[];
    return rows.find(row => this.rowHasNegationMismatch(row.summary, summaryTerms));
  }

  searchRelevant(query: string, limit: number = 10): SharedMemoryRow[] {
    const tokens = query.split(/\s+/).filter(t => t.length > 0).map(t => t.replace(/"/g, '""'));
    if (tokens.length === 0) {
      const stmt = this.db.prepare('SELECT * FROM shared_memories WHERE dismissed = 0 ORDER BY updated_at DESC LIMIT ?');
      return stmt.all(limit) as SharedMemoryRow[];
    }
    const ftsQuery = tokens.join(' OR ');
    const ftsStmt = this.db.prepare(`
      SELECT m.* FROM shared_memories m
      JOIN shared_memories_fts fts ON m.rowid = fts.rowid
      WHERE shared_memories_fts MATCH ? AND m.dismissed = 0
      ORDER BY rank
      LIMIT ?
    `);
    try {
      return ftsStmt.all(ftsQuery, limit) as SharedMemoryRow[];
    } catch {
      const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
      const stmt = this.db.prepare(`SELECT * FROM shared_memories WHERE dismissed = 0 AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`);
      const likeValues = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      return stmt.all(...likeValues, limit) as SharedMemoryRow[];
    }
  }

  softDelete(id: string): boolean {
    const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE id = ?');
    const result = stmt.run(Date.now(), id);
    if (result.changes > 0) this.pruneEmptyCategories();
    return result.changes > 0;
  }

  clearByType(type?: string): number {
    if (type) {
      const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE type = ? AND dismissed = 0');
      const result = stmt.run(Date.now(), type);
      if (result.changes > 0) this.pruneEmptyCategories();
      return result.changes;
    }
    const stmt = this.db.prepare('UPDATE shared_memories SET dismissed = 1, updated_at = ? WHERE dismissed = 0');
    const result = stmt.run(Date.now());
    if (result.changes > 0) this.pruneEmptyCategories();
    return result.changes;
  }

  totalActive(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM shared_memories WHERE dismissed = 0');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countByType(): Record<string, number> {
    const stmt = this.db.prepare("SELECT type, COUNT(*) as count FROM shared_memories WHERE dismissed = 0 GROUP BY type");
    const rows = stmt.all() as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  countByCategory(): Record<string, number> {
    const stmt = this.db.prepare("SELECT category, COUNT(*) as count FROM shared_memories WHERE dismissed = 0 GROUP BY category");
    const rows = stmt.all() as Array<{ category: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.category] = row.count;
    }
    return result;
  }

  getCategories(): string[] {
    const raw = this.getMeta('categories');
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  addCategory(category: string): void {
    const existing = this.getCategories();
    if (!existing.includes(category)) {
      existing.push(category);
      this.setMeta('categories', JSON.stringify(existing));
    }
  }

  findBestCategoryMatch(candidateCategory: string): string | null {
    const existing = this.getCategories();
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

  pruneEmptyCategories(): void {
    const categories = this.getCategories();
    if (categories.length === 0) return;

    const counts = this.countByCategory();
    const alive = categories.filter(c => (counts[c] ?? 0) > 0);

    if (alive.length < categories.length) {
      this.setMeta('categories', JSON.stringify(alive));

      // clean up friend_access rows for removed categories
      const removed = categories.filter(c => !alive.includes(c));
      const placeholders = removed.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM friend_access WHERE category IN (${placeholders})`).run(...removed);
    }
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

  close(): void {
    this.db.close();
  }

  private rowHasNegationMismatch(existingSummary: string, incomingTerms: string[]): boolean {
    const lower = existingSummary.toLowerCase();
    const negationWords = ['not', 'never', 'no longer', 'avoid', 'against', 'disabled'];
    const hasNegation = negationWords.some(w => lower.includes(w));
    const incomingLower = incomingTerms.join(' ');
    const incomingHasNegation = negationWords.some(w => incomingLower.includes(w));
    return hasNegation !== incomingHasNegation;
  }
}