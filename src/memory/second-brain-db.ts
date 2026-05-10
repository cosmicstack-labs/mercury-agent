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

function ensureProbed(): void {
  if (availabilityChecked) return;
  availabilityChecked = true;
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
}

export function isBetterSqlite3Available(): boolean {
  ensureProbed();
  return syncDatabaseClass !== null;
}

export interface MemoryRow {
  id: string;
  user_key: string;
  type: string;
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

export class SecondBrainDB {
  private db: BetterSqlite3Database;

  constructor(dbPath: string) {
    ensureProbed();
    if (!syncDatabaseClass) {
      throw new Error(
        'better-sqlite3 is not available — second brain memory requires it. ' +
        'Install build tools (make, gcc/g++, python3) or upgrade to Node >= 20. ' +
        'See: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md'
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
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        type TEXT NOT NULL,
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

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        summary, detail, content=memories, content_rowid=rowid
      );

      CREATE TABLE IF NOT EXISTS second_brain_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_key, type);
      CREATE INDEX IF NOT EXISTS idx_memories_user_dismissed ON memories(user_key, dismissed);
      CREATE INDEX IF NOT EXISTS idx_memories_user_updated ON memories(user_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memories_user_scope ON memories(user_key, scope);
      CREATE INDEX IF NOT EXISTS idx_memories_user_evidence_kind ON memories(user_key, evidence_kind);

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
        INSERT INTO memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;
    `);

    this.db.pragma('foreign_keys = ON');
    logger.info('Second brain database initialized');
  }

  insert(row: Omit<MemoryRow, 'rowid'> & { rowid?: never }): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_key, type, summary, detail, scope, evidence_kind, source,
        confidence, importance, durability, evidence_count, provenance,
        dismissed, superseded_by, created_at, updated_at,
        last_seen_at, last_used_at, last_used_query
      ) VALUES (
        @id, @user_key, @type, @summary, @detail, @scope, @evidence_kind, @source,
        @confidence, @importance, @durability, @evidence_count, @provenance,
        @dismissed, @superseded_by, @created_at, @updated_at,
        @last_seen_at, @last_used_at, @last_used_query
      )
    `);
    stmt.run({
      id: row.id,
      user_key: row.user_key,
      type: row.type,
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

  update(row: Partial<MemoryRow> & { id: string }): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id: row.id };

    const allowedFields = [
      'summary', 'detail', 'scope', 'evidence_kind', 'source',
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

    const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = @id`);
    stmt.run(values);
  }

  getActive(userKey: string): MemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(userKey) as MemoryRow[];
  }

  getById(id: string): MemoryRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    return stmt.get(id) as MemoryRow | undefined;
  }

  getByType(userKey: string, type: string): MemoryRow[] {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE user_key = ? AND type = ? AND dismissed = 0 ORDER BY updated_at DESC');
    return stmt.all(userKey, type) as MemoryRow[];
  }

  findMergeCandidate(userKey: string, type: string, normalizedTerms: string[]): MemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_key = ? AND type = ? AND dismissed = 0
      AND (summary LIKE ? OR ${normalizedTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likeAny = normalizedTerms.map(t => `%${t}%`);
    const rows = stmt.all(userKey, type, `%${normalizedTerms.slice(0, 3).join('%')}%`, ...likeAny) as MemoryRow[];
    return rows.find(row => !this.rowHasNegationMismatch(row.summary, normalizedTerms));
  }

  findConflictCandidate(userKey: string, type: string, summaryTerms: string[]): MemoryRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_key = ? AND type = ? AND dismissed = 0
      AND (${summaryTerms.map(() => 'summary LIKE ?').join(' OR ')})
      LIMIT 5
    `);
    const likes = summaryTerms.map(t => `%${t}%`);
    const rows = stmt.all(userKey, type, ...likes) as MemoryRow[];
    return rows.find(row => this.rowHasNegationMismatch(row.summary, summaryTerms));
  }

  private rowHasNegationMismatch(existingSummary: string, incomingTerms: string[]): boolean {
    const lower = existingSummary.toLowerCase();
    const negationWords = ['not', 'never', 'no longer', 'avoid', 'against', 'disabled'];
    const hasNegation = negationWords.some(w => lower.includes(w));
    const incomingLower = incomingTerms.join(' ');
    const incomingHasNegation = negationWords.some(w => incomingLower.includes(w));
    return hasNegation !== incomingHasNegation;
  }

  searchRelevant(userKey: string, query: string, limit: number = 10): MemoryRow[] {
    const tokens = query.split(/\s+/).filter(t => t.length > 0).map(t => t.replace(/"/g, '""'));
    if (tokens.length === 0) {
      const stmt = this.db.prepare('SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 ORDER BY updated_at DESC LIMIT ?');
      return stmt.all(userKey, limit) as MemoryRow[];
    }
    const ftsQuery = tokens.join(' OR ');
    const ftsStmt = this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.user_key = ? AND m.dismissed = 0
      ORDER BY rank
      LIMIT ?
    `);
    try {
      return ftsStmt.all(ftsQuery, userKey, limit) as MemoryRow[];
    } catch {
      const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`);
      const likes = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      return stmt.all(userKey, ...likes, limit) as MemoryRow[];
    }
  }

  searchFTS(userKey: string, query: string, limit: number = 10): MemoryRow[] {
    return this.searchRelevant(userKey, query, limit);
  }

  softDelete(id: string): boolean {
    const stmt = this.db.prepare('UPDATE memories SET dismissed = 1, updated_at = ? WHERE id = ?');
    const result = stmt.run(Date.now(), id);
    return result.changes > 0;
  }

  clearByType(userKey: string, type?: string): number {
    if (type) {
      const stmt = this.db.prepare('UPDATE memories SET dismissed = 1, updated_at = ? WHERE user_key = ? AND type = ? AND dismissed = 0');
      const result = stmt.run(Date.now(), userKey, type);
      return result.changes;
    }
    const stmt = this.db.prepare('UPDATE memories SET dismissed = 1, updated_at = ? WHERE user_key = ? AND dismissed = 0');
    const result = stmt.run(Date.now(), userKey);
    return result.changes;
  }

  hardDeleteDismissed(userKey: string): number {
    const stmt = this.db.prepare('DELETE FROM memories WHERE user_key = ? AND dismissed = 1');
    const result = stmt.run(userKey);
    return result.changes;
  }

  promoteToDurable(userKey: string): number {
    const stmt = this.db.prepare(`
      UPDATE memories SET scope = 'durable', updated_at = ?
      WHERE user_key = ? AND scope = 'active' AND dismissed = 0
        AND evidence_count >= 3 AND evidence_kind IN ('direct', 'manual')
    `);
    const result = stmt.run(Date.now(), userKey);
    return result.changes;
  }

  pruneStale(userKey: string): { activePruned: number; durablePruned: number } {
    const now = Date.now();
    const twentyOneDays = 21 * 24 * 60 * 60 * 1000;
    const fortyTwoDays = 42 * 24 * 60 * 60 * 1000;
    const oneHundredTwentyDays = 120 * 24 * 60 * 60 * 1000;

    const activeInferred = this.db.prepare(`
      UPDATE memories SET dismissed = 1, updated_at = ?
      WHERE user_key = ? AND scope = 'active' AND evidence_kind = 'inferred' AND dismissed = 0
        AND last_seen_at < ? AND last_seen_at > 0
    `);
    const activeInferredResult = activeInferred.run(now, userKey, now - twentyOneDays);

    const activeDirect = this.db.prepare(`
      UPDATE memories SET dismissed = 1, updated_at = ?
      WHERE user_key = ? AND scope = 'active' AND evidence_kind = 'direct' AND dismissed = 0
        AND last_seen_at < ? AND last_seen_at > 0
    `);
    const activeDirectResult = activeDirect.run(now, userKey, now - fortyTwoDays);

    const activePruned = activeInferredResult.changes + activeDirectResult.changes;

    const durableInferred = this.db.prepare(`
      UPDATE memories SET confidence = MAX(0.15, confidence - 0.15), updated_at = ?
      WHERE user_key = ? AND scope = 'durable' AND evidence_kind = 'inferred' AND dismissed = 0
        AND last_seen_at < ? AND last_seen_at > 0
    `);
    durableInferred.run(now, userKey, now - oneHundredTwentyDays);

    const durablePruned = this.db.prepare(`
      UPDATE memories SET dismissed = 1, updated_at = ?
      WHERE user_key = ? AND scope = 'durable' AND dismissed = 0
        AND confidence < 0.3 AND last_seen_at < ? AND last_seen_at > 0
    `);
    const durablePrunedResult = durablePruned.run(now, userKey, now - oneHundredTwentyDays);

    return { activePruned, durablePruned: durablePrunedResult.changes };
  }

  setMeta(key: string, value: string): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO second_brain_meta (key, value) VALUES (@key, @value)');
    stmt.run({ key, value });
  }

  getMeta(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM second_brain_meta WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteMeta(key: string): void {
    const stmt = this.db.prepare('DELETE FROM second_brain_meta WHERE key = ?');
    stmt.run(key);
  }

  countByType(userKey: string): Record<string, number> {
    const stmt = this.db.prepare("SELECT type, COUNT(*) as count FROM memories WHERE user_key = ? AND dismissed = 0 GROUP BY type");
    const rows = stmt.all(userKey) as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  totalActive(userKey: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_key = ? AND dismissed = 0');
    const row = stmt.get(userKey) as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}