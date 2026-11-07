import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { isSqliteAvailable, openSqlite, type SqliteDatabase } from '../utils/sqlite-driver.js';
import { exclusiveGroup, normalizeRelationship } from './person-standing.js';

/**
 * True when any SQLite engine is available (better-sqlite3, bun:sqlite or
 * node:sqlite — see `src/utils/sqlite-driver.ts`).
 * @deprecated The name predates the shared driver; prefer `isSqliteAvailable()`.
 */
export function isBetterSqlite3Available(): boolean {
  return isSqliteAvailable();
}

export const SECOND_BRAIN_UNAVAILABLE_MESSAGE =
  'No SQLite engine is available — second brain memory requires one. ' +
  'Use Node >= 22.13 (built-in node:sqlite), a standalone Mercury binary (bun:sqlite), ' +
  'or install build tools (make, gcc/g++, python3) and run `npm rebuild better-sqlite3`. ' +
  'Run `mercury doctor --storage` for details.';

export interface MemoryRow {
  id: string;
  user_key: string;
  type: string;
  categories: string;
  shareable: number;
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

export interface PersonRow {
  id: string;
  user_key: string;
  canonical_name: string;
  display_name: string;
  relationship_to_user: string | null;
  description: string | null;
  confidence: number;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
  /** 'person' | 'pet' | 'unverified' (never 'not_person': those are not stored). */
  kind?: string;
  /** Who decided `kind`: 'owner' | 'model' | 'rule' | null. */
  verified_by?: string | null;
  /** Contact card: JSON { phone, email, birthday, location, company, notes, links[] }. */
  meta?: string;
  /** 1 = the owner edited this person; rebuilds never overwrite or delete it. */
  owner_edited?: number;
}

export type PersonKind = 'person' | 'pet' | 'unverified';

export interface PersonGraph {
  persons: Array<{ id: string; name: string; kind: string; relationship: string | null; memoryCount: number }>;
  memories: Array<{ id: string; summary: string; type: string; importance: number; updatedAt: number }>;
  memoryPersons: Array<{ memoryId: string; personId: string; role: string }>;
  relationships: Array<{ source: string; target: string; type: string; strength: number }>;
}

export interface PersonListRow extends PersonRow {
  memory_count: number;
}

export interface PersonConnectionRow {
  id: string;
  display_name: string;
  relation_type: string;
  strength: number;
}

/** Most distinct terms a memory search uses; keeps queries far below SQLite's
 *  expression-depth limit (1000), which a long pasted message used to blow
 *  through in both the FTS query and its LIKE fallback, failing the turn. */
const MAX_SEARCH_TERMS = 32;

/**
 * Search terms for a free-text query: distinct lowercase words of 2+ letters
 * or digits (punctuation and FTS operators can't leak in), first occurrence
 * order, capped at MAX_SEARCH_TERMS.
 */
export function ftsSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const term = match[0];
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    if (seen.size >= MAX_SEARCH_TERMS) break;
  }
  return [...seen];
}

export class SecondBrainDB {
  private db: SqliteDatabase;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const db = openSqlite(dbPath);
    if (!db) throw new Error(SECOND_BRAIN_UNAVAILABLE_MESSAGE);
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  /** Engine backing this database: `better-sqlite3`, `bun:sqlite` or `node:sqlite`. */
  get backend(): string {
    return this.db.backend;
  }

  /** The shared connection, for stores that keep their own tables in this file (beliefs). */
  get connection(): SqliteDatabase {
    return this.db;
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        type TEXT NOT NULL,
        categories TEXT NOT NULL DEFAULT '[]',
        shareable INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        relationship_to_user TEXT,
        description TEXT,
        confidence REAL NOT NULL DEFAULT 0.6,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_key, canonical_name)
      );

      CREATE TABLE IF NOT EXISTS person_aliases (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        created_at INTEGER NOT NULL,
        UNIQUE(person_id, normalized_alias),
        FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_persons (
        memory_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'mentioned',
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(memory_id, person_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS person_relationships (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        source_person_id TEXT NOT NULL,
        target_person_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        evidence_memory_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_key, source_person_id, target_person_id, relation_type),
        FOREIGN KEY (source_person_id) REFERENCES persons(id) ON DELETE CASCADE,
        FOREIGN KEY (target_person_id) REFERENCES persons(id) ON DELETE CASCADE,
        FOREIGN KEY (evidence_memory_id) REFERENCES memories(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_key, type);
      CREATE INDEX IF NOT EXISTS idx_memories_user_dismissed ON memories(user_key, dismissed);
      CREATE INDEX IF NOT EXISTS idx_memories_user_updated ON memories(user_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memories_user_scope ON memories(user_key, scope);
      CREATE INDEX IF NOT EXISTS idx_memories_user_evidence_kind ON memories(user_key, evidence_kind);
      CREATE INDEX IF NOT EXISTS idx_persons_user_name ON persons(user_key, canonical_name);
      CREATE INDEX IF NOT EXISTS idx_person_aliases_person ON person_aliases(person_id);
      CREATE INDEX IF NOT EXISTS idx_memory_persons_person ON memory_persons(person_id);
      CREATE INDEX IF NOT EXISTS idx_person_relationships_source ON person_relationships(source_person_id);
      CREATE INDEX IF NOT EXISTS idx_person_relationships_target ON person_relationships(target_person_id);

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

    // ── Migrations for existing DBs ──────────────────────────────────────────
    // Add `categories` and `shareable` columns if the table predates them.
    // Existing memories get categories='[]' and shareable=0 (private).
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'categories')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'");
      logger.info('Added categories column to memories table');
    }
    if (!columns.some((c) => c.name === 'shareable')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0');
      logger.info('Added shareable column to memories table');
    }

    // Index for incremental fetch (shareable + updated_at — the cloud pull query).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_shareable_updated ON memories(shareable, updated_at)');

    // People: what an entity is, who decided, the contact card, and owner edits.
    const personColumns = this.db.prepare('PRAGMA table_info(persons)').all() as { name: string }[];
    const addPersonColumn = (name: string, ddl: string) => {
      if (!personColumns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE persons ADD COLUMN ${ddl}`);
    };
    addPersonColumn('kind', "kind TEXT NOT NULL DEFAULT 'unverified'");
    addPersonColumn('verified_by', 'verified_by TEXT');
    addPersonColumn('meta', "meta TEXT NOT NULL DEFAULT '{}'");
    addPersonColumn('owner_edited', 'owner_edited INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_overrides (
        user_key TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_person_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_key, canonical_name)
      );
      CREATE TABLE IF NOT EXISTS belief_persons (
        belief_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'mentioned',
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (belief_id, person_id),
        FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_belief_persons_person ON belief_persons(person_id);
      CREATE TABLE IF NOT EXISTS person_checks (
        person_id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        name TEXT NOT NULL,
        context TEXT,
        queued_at INTEGER NOT NULL,
        FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
      );
    `);

    logger.info({ backend: this.db.backend }, 'Second brain database initialized');
  }

  insert(row: Omit<MemoryRow, 'rowid'> & { rowid?: never }): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_key, type, categories, shareable, summary, detail, scope, evidence_kind, source,
        confidence, importance, durability, evidence_count, provenance,
        dismissed, superseded_by, created_at, updated_at,
        last_seen_at, last_used_at, last_used_query
      ) VALUES (
        @id, @user_key, @type, @categories, @shareable, @summary, @detail, @scope, @evidence_kind, @source,
        @confidence, @importance, @durability, @evidence_count, @provenance,
        @dismissed, @superseded_by, @created_at, @updated_at,
        @last_seen_at, @last_used_at, @last_used_query
      )
    `);
    stmt.run({
      id: row.id,
      user_key: row.user_key,
      type: row.type,
      categories: row.categories ?? '[]',
      shareable: row.shareable ?? 0,
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
      'categories', 'shareable',
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
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active', 'durable') ORDER BY updated_at DESC`);
    return stmt.all(userKey) as MemoryRow[];
  }

  getById(id: string): MemoryRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    return stmt.get(id) as MemoryRow | undefined;
  }

  /**
   * Incremental fetch query — shareable memories newer than the cursor.
   * Used by the cloud `memory.fetch` handler to pull only memories created or
   * updated since the last fetch (watermark stored in MemorySyncState).
   * Excludes dismissed rows. Ordered by `updated_at ASC` so the cloud can
   * advance its cursor to the max `updated_at` safely.
   */
  getShareableSince(userKey: string, since: number, limit: number = 500): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_key = ? AND shareable = 1 AND dismissed = 0
      AND updated_at > ?
      ORDER BY updated_at ASC
      LIMIT ?
    `);
    return stmt.all(userKey, since, limit) as MemoryRow[];
  }

  /** Count shareable memories (for display / config). */
  countShareable(userKey: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_key = ? AND shareable = 1 AND dismissed = 0');
    return (stmt.get(userKey) as { count: number }).count;
  }

  /** List all shareable memories (for the /memory menu "Shared Memories" view). */
  getShareable(userKey: string, limit: number = 50): MemoryRow[] {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND shareable = 1 AND dismissed = 0 ORDER BY updated_at DESC LIMIT ?`);
    return stmt.all(userKey, limit) as MemoryRow[];
  }

  /** Toggle a memory's shareable flag on/off. */
  setShareable(id: string, shareable: boolean): void {
    const stmt = this.db.prepare('UPDATE memories SET shareable = ?, updated_at = ? WHERE id = ?');
    stmt.run(shareable ? 1 : 0, Date.now(), id);
  }

  getByType(userKey: string, type: string): MemoryRow[] {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND type = ? AND dismissed = 0 AND scope IN ('active', 'durable') ORDER BY updated_at DESC`);
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
    const tokens = ftsSearchTerms(query);
    if (tokens.length === 0) {
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active', 'durable') ORDER BY updated_at DESC LIMIT ?`);
      return stmt.all(userKey, limit) as MemoryRow[];
    }
    // Quoted: punctuation in a term can't break FTS5 query syntax.
    const ftsQuery = tokens.map((term) => `"${term}"`).join(' OR ');
    const ftsStmt = this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.user_key = ? AND m.dismissed = 0 AND m.scope IN ('active', 'durable')
      ORDER BY rank
      LIMIT ?
    `);
    try {
      return ftsStmt.all(ftsQuery, userKey, limit) as MemoryRow[];
    } catch {
      const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active', 'durable') AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`);
      const likes = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      return stmt.all(userKey, ...likes, limit) as MemoryRow[];
    }
  }

  searchSubconscious(userKey: string, query: string, limit: number = 10): MemoryRow[] {
    const tokens = ftsSearchTerms(query);
    if (tokens.length === 0) {
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope = 'subconscious' ORDER BY updated_at DESC LIMIT ?`);
      return stmt.all(userKey, limit) as MemoryRow[];
    }
    // Quoted: punctuation in a term can't break FTS5 query syntax.
    const ftsQuery = tokens.map((term) => `"${term}"`).join(' OR ');
    const ftsStmt = this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.user_key = ? AND m.dismissed = 0 AND m.scope = 'subconscious'
      ORDER BY rank
      LIMIT ?
    `);
    try {
      return ftsStmt.all(ftsQuery, userKey, limit) as MemoryRow[];
    } catch {
      const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope = 'subconscious' AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ?`);
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

  moveToSubconscious(userKey: string): number {
    const SUBCONSCIOUS_THRESHOLD_DAYS = 30;
    const threshold = SUBCONSCIOUS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - threshold;

    const stmt = this.db.prepare(`
      UPDATE memories SET scope = 'subconscious', updated_at = ?
      WHERE user_key = ? AND dismissed = 0
        AND scope IN ('active', 'durable')
        AND last_seen_at < ? AND last_seen_at > 0
    `);
    const result = stmt.run(Date.now(), userKey, cutoff);
    return result.changes;
  }

  promoteToConscious(id: string, newScope: 'active' | 'durable'): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE memories SET scope = ?, updated_at = ?, last_seen_at = ? WHERE id = ? AND scope = 'subconscious'`
    );
    const result = stmt.run(newScope, now, now, id);
    return result.changes > 0;
  }

  getSubconscious(userKey: string): MemoryRow[] {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope = 'subconscious' ORDER BY updated_at DESC`);
    return stmt.all(userKey) as MemoryRow[];
  }

  countSubconscious(userKey: string): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM memories WHERE user_key = ? AND dismissed = 0 AND scope = 'subconscious'`);
    const row = stmt.get(userKey) as { count: number };
    return row.count;
  }

  getMemoriesByIds(ids: string[]): MemoryRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`);
    return stmt.all(...ids) as MemoryRow[];
  }

  upsertPerson(params: {
    userKey: string;
    name: string;
    relationshipToUser?: string | null;
    confidence?: number;
    description?: string | null;
    personId?: string;
    /**
     * Context for a model check. A check is queued only when an unreviewed
     * name RECURS (its second sighting), never on first sight and never in
     * rebuilds: one-off names cost no tokens.
     */
    queueCheck?: { context: string } | null;
  }): PersonRow | null {
    const now = Date.now();
    const normalized = this.normalizePersonName(params.name);
    if (!normalized) return null;

    // The owner's decisions win over every extraction, including rebuilds.
    const override = this.db.prepare('SELECT action, target_person_id FROM person_overrides WHERE user_key = ? AND canonical_name = ? LIMIT 1')
      .get(params.userKey, normalized) as { action: string; target_person_id: string | null } | undefined;
    if (override?.action === 'not_person') return null;

    const existingStmt = this.db.prepare('SELECT * FROM persons WHERE user_key = ? AND canonical_name = ? LIMIT 1');
    let existing = existingStmt.get(params.userKey, normalized) as PersonRow | undefined;
    if (!existing && override?.action === 'merge' && override.target_person_id) existing = this.getPersonById(override.target_person_id);
    if (!existing) {
      // A name the owner gave another person (rename, merge) resolves to that person.
      existing = this.db.prepare(`
        SELECT p.* FROM person_aliases a JOIN persons p ON p.id = a.person_id
        WHERE p.user_key = ? AND a.normalized_alias = ? ORDER BY p.owner_edited DESC LIMIT 1
      `).get(params.userKey, normalized) as PersonRow | undefined;
    }

    if (existing && existing.owner_edited === 1) {
      this.db.prepare('UPDATE persons SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, existing.id);
      return this.getPersonById(existing.id) ?? existing;
    }

    if (existing) {
      const confidence = Math.max(existing.confidence, params.confidence ?? existing.confidence);
      // A plain mention ("known") never erases a real relationship ("wife").
      const incoming = this.allowedRelationship(params.userKey, existing.id, params.relationshipToUser);
      // A specific relationship already stored wins over a vaguer one ("wife" over "spouse").
      const current = existing.relationship_to_user;
      const currentSpecific = !!current && !['known', 'spouse', 'family'].includes(current);
      const relationshipToUser = incoming && incoming !== 'known' && !currentSpecific ? incoming : current ?? incoming;
      const description = params.description ?? existing.description;
      this.db.prepare(`
        UPDATE persons
        SET display_name = ?, relationship_to_user = ?, description = ?, confidence = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `).run(params.name.trim(), relationshipToUser, description, confidence, now, now, existing.id);

      const updated = this.getPersonById(existing.id);
      if (!updated) throw new Error('Failed to update person record');
      if (params.queueCheck && !updated.verified_by && (updated.kind ?? 'unverified') === 'unverified') {
        this.db.prepare('INSERT OR IGNORE INTO person_checks (person_id, user_key, name, context, queued_at) VALUES (?, ?, ?, ?, ?)')
          .run(updated.id, params.userKey, updated.display_name, params.queueCheck.context.slice(0, 400), now);
      }
      return updated;
    }

    const id = params.personId || `per_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const confidence = params.confidence ?? 0.7;
    params = { ...params, relationshipToUser: this.allowedRelationship(params.userKey, id, params.relationshipToUser) ?? (params.relationshipToUser ? 'known' : null) };
    this.db.prepare(`
      INSERT INTO persons (
        id, user_key, canonical_name, display_name, relationship_to_user,
        description, confidence, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.userKey,
      normalized,
      params.name.trim(),
      params.relationshipToUser ?? null,
      params.description ?? null,
      confidence,
      now,
      now,
      now,
      now,
    );

    const created = this.getPersonById(id);
    if (!created) throw new Error('Failed to create person record');
    return created;
  }

  /**
   * Cardinality: a one-to-one relation (wife, mother, manager…) belongs to one
   * person at a time. An extracted claim never takes it from someone who
   * already holds it; only the owner can move it (see moveExclusiveRelationship).
   * Returns the relationship to store, or null to keep what is there.
   */
  private allowedRelationship(userKey: string, personId: string, relationship: string | null | undefined): string | null {
    const rel = normalizeRelationship(relationship);
    if (!rel) return null;
    const group = exclusiveGroup(rel);
    if (!group) return rel;
    const holder = this.exclusiveHolder(userKey, group, personId);
    return holder ? null : rel;
  }

  /** Who holds a one-to-one relation group (spouse, mother…), other than `exceptId`. */
  exclusiveHolder(userKey: string, group: string, exceptId?: string): PersonRow | undefined {
    const rows = this.db.prepare(`SELECT * FROM persons WHERE user_key = ? AND relationship_to_user IS NOT NULL AND relationship_to_user != 'known' AND id != ?`)
      .all(userKey, exceptId ?? '') as PersonRow[];
    return rows.find((r) => exclusiveGroup(r.relationship_to_user) === group);
  }

  /** Owner moves a one-to-one relation: the previous holder becomes "known". */
  releaseExclusiveRelationship(userKey: string, group: string, exceptId: string): PersonRow | undefined {
    const holder = this.exclusiveHolder(userKey, group, exceptId);
    if (holder) this.db.prepare(`UPDATE persons SET relationship_to_user = 'known', updated_at = ? WHERE id = ?`).run(Date.now(), holder.id);
    return holder;
  }

  /** Find a person by name or alias without creating one. */
  resolvePersonId(userKey: string, name: string): string | null {
    const normalized = this.normalizePersonName(name);
    if (!normalized) return null;
    const direct = this.db.prepare('SELECT id FROM persons WHERE user_key = ? AND canonical_name = ? LIMIT 1').get(userKey, normalized) as { id: string } | undefined;
    if (direct) return direct.id;
    const alias = this.db.prepare('SELECT p.id FROM person_aliases a JOIN persons p ON p.id = a.person_id WHERE p.user_key = ? AND a.normalized_alias = ? LIMIT 1').get(userKey, normalized) as { id: string } | undefined;
    return alias?.id ?? null;
  }

  /**
   * The evidence behind each person, for standing (person-standing.ts):
   * mentions in live beliefs and the archive, how many are social, the days
   * they span, and links to other people. Grouped queries, one pass.
   */
  personEvidence(userKey: string): Array<{ id: string; relationship: string | null; kind: string | null; verified_by: string | null; owner_edited: number; mentions: number; social: number; days: number; plinks: number }> {
    return this.db.prepare(`
      WITH links AS (
        SELECT bp.person_id AS pid, b.kind AS kind, b.created_at AS ts FROM belief_persons bp
          JOIN beliefs b ON b.id = bp.belief_id AND b.status IN ('candidate','held','confirmed','contested')
        UNION ALL
        SELECT mp.person_id, m.type, m.created_at FROM memory_persons mp
          JOIN memories m ON m.id = mp.memory_id AND m.dismissed = 0
      ),
      agg AS (
        SELECT pid, COUNT(*) AS mentions, SUM(CASE WHEN kind IN ('relationship','episode') THEN 1 ELSE 0 END) AS social,
          COUNT(DISTINCT date(ts / 1000, 'unixepoch', 'localtime')) AS days
        FROM links GROUP BY pid
      ),
      rel AS (
        SELECT pid, COUNT(*) AS n FROM (
          SELECT source_person_id AS pid FROM person_relationships WHERE user_key = ?
          UNION ALL SELECT target_person_id FROM person_relationships WHERE user_key = ?
        ) GROUP BY pid
      )
      SELECT p.id, p.relationship_to_user AS relationship, p.kind, p.verified_by, p.owner_edited,
        COALESCE(agg.mentions, 0) AS mentions, COALESCE(agg.social, 0) AS social, COALESCE(agg.days, 0) AS days, COALESCE(rel.n, 0) AS plinks
      FROM persons p LEFT JOIN agg ON agg.pid = p.id LEFT JOIN rel ON rel.pid = p.id
      WHERE p.user_key = ?
    `).all(userKey, userKey, userKey) as Array<{ id: string; relationship: string | null; kind: string | null; verified_by: string | null; owner_edited: number; mentions: number; social: number; days: number; plinks: number }>;
  }

  // ── People in beliefs (the live brain since the Owner Model) ─────────────

  linkBeliefPerson(beliefId: string, personId: string, role: string, confidence: number): void {
    this.db.prepare(`INSERT INTO belief_persons (belief_id, person_id, role, confidence, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(belief_id, person_id) DO UPDATE SET role = excluded.role, confidence = excluded.confidence`).run(beliefId, personId, role, confidence, Date.now());
  }

  clearBeliefPersons(beliefId: string): void {
    this.db.prepare('DELETE FROM belief_persons WHERE belief_id = ?').run(beliefId);
  }

  clearAllBeliefPersons(userKey: string): void {
    this.db.prepare('DELETE FROM belief_persons WHERE person_id IN (SELECT id FROM persons WHERE user_key = ?)').run(userKey);
  }

  /** Live beliefs created after `since` (ms), oldest first, for incremental person indexing. */
  /** Beliefs after a (created_at, rowid) cursor, in the order they were made: two made in the same millisecond are both seen. */
  beliefsSince(userKey: string, since: number, limit = 500, sinceSeq = -1): Array<{ id: string; statement: string; detail: string | null; kind: string; confidence: number; created_at: number; seq: number }> {
    return this.db.prepare(`SELECT id, statement, detail, kind, MIN(1, 0.5 + support / 10.0) AS confidence, created_at, rowid AS seq FROM beliefs
      WHERE owner_key = ? AND (created_at > ? OR (created_at = ? AND rowid > ?)) AND status IN ('candidate', 'held', 'confirmed', 'contested') ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(userKey, since, since, sinceSeq, limit) as Array<{ id: string; statement: string; detail: string | null; kind: string; confidence: number; created_at: number; seq: number }>;
  }

  // ── Owner curation of people ─────────────────────────────────────────────

  updatePerson(userKey: string, id: string, fields: { displayName?: string; relationship?: string | null; description?: string | null; kind?: PersonKind; meta?: Record<string, unknown> }): PersonRow | null {
    const row = this.getPersonById(id);
    if (!row || row.user_key !== userKey) return null;
    const now = Date.now();
    const meta = fields.meta !== undefined ? JSON.stringify(fields.meta) : row.meta ?? '{}';
    const kind = fields.kind ?? row.kind ?? 'unverified';
    const displayName = fields.displayName?.trim() || row.display_name;
    this.db.prepare(`
      UPDATE persons SET display_name = ?, relationship_to_user = ?, description = ?, kind = ?, verified_by = ?, meta = ?, owner_edited = 1, updated_at = ?
      WHERE id = ?
    `).run(
      displayName,
      fields.relationship !== undefined ? normalizeRelationship(fields.relationship) : row.relationship_to_user,
      fields.description !== undefined ? fields.description : row.description,
      kind,
      fields.kind !== undefined ? 'owner' : row.verified_by ?? null,
      meta,
      now,
      id,
    );
    // The id never changes; a new name becomes an alias, so future mentions link here.
    if (fields.displayName && fields.displayName.trim() !== row.display_name) this.addPersonAlias(id, fields.displayName.trim(), 'owner');
    this.db.prepare('DELETE FROM person_checks WHERE person_id = ?').run(id);
    return this.getPersonById(id) ?? null;
  }

  /** "This isn't a person": forget the entity, and never create it again. */
  markNotPerson(userKey: string, id: string): boolean {
    const row = this.getPersonById(id);
    if (!row || row.user_key !== userKey) return false;
    const names = [row.canonical_name, ...(this.db.prepare('SELECT normalized_alias FROM person_aliases WHERE person_id = ?').all(id) as Array<{ normalized_alias: string }>).map((a) => a.normalized_alias)];
    const now = Date.now();
    const put = this.db.prepare(`INSERT INTO person_overrides (user_key, canonical_name, action, target_person_id, created_at) VALUES (?, ?, 'not_person', NULL, ?)
      ON CONFLICT(user_key, canonical_name) DO UPDATE SET action = 'not_person', target_person_id = NULL, created_at = excluded.created_at`);
    for (const n of new Set(names)) put.run(userKey, n, now);
    this.db.prepare('DELETE FROM persons WHERE id = ?').run(id);
    return true;
  }

  /** Merge `fromId` into `intoId`: links, relationships and names move; `intoId` keeps its id. */
  mergePersons(userKey: string, fromId: string, intoId: string, opts: { byOwner?: boolean } = {}): boolean {
    const byOwner = opts.byOwner ?? true;
    if (fromId === intoId) return false;
    const from = this.getPersonById(fromId);
    const into = this.getPersonById(intoId);
    if (!from || !into || from.user_key !== userKey || into.user_key !== userKey) return false;
    const now = Date.now();
    // The driver runs the function inside BEGIN/COMMIT right away.
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO memory_persons (memory_id, person_id, role, confidence, created_at, updated_at)
        SELECT memory_id, ?, role, confidence, created_at, ? FROM memory_persons WHERE person_id = ?
        ON CONFLICT(memory_id, person_id) DO NOTHING`).run(intoId, now, fromId);
      this.db.prepare(`INSERT INTO belief_persons (belief_id, person_id, role, confidence, created_at)
        SELECT belief_id, ?, role, confidence, created_at FROM belief_persons WHERE person_id = ?
        ON CONFLICT(belief_id, person_id) DO NOTHING`).run(intoId, fromId);
      this.db.prepare('UPDATE OR IGNORE person_relationships SET source_person_id = ? WHERE source_person_id = ?').run(intoId, fromId);
      this.db.prepare('UPDATE OR IGNORE person_relationships SET target_person_id = ? WHERE target_person_id = ?').run(intoId, fromId);
      this.db.prepare('DELETE FROM person_relationships WHERE source_person_id = target_person_id').run();
      const aliases = [from.display_name, ...(this.db.prepare('SELECT alias FROM person_aliases WHERE person_id = ?').all(fromId) as Array<{ alias: string }>).map((a) => a.alias)];
      for (const a of aliases) this.addPersonAlias(intoId, a, byOwner ? 'owner' : 'memory');
      const put = this.db.prepare(`INSERT INTO person_overrides (user_key, canonical_name, action, target_person_id, created_at) VALUES (?, ?, 'merge', ?, ?)
        ON CONFLICT(user_key, canonical_name) DO UPDATE SET action = 'merge', target_person_id = excluded.target_person_id, created_at = excluded.created_at`);
      put.run(userKey, from.canonical_name, intoId, now);
      this.db.prepare('DELETE FROM persons WHERE id = ?').run(fromId);
      if (byOwner) this.db.prepare('UPDATE persons SET owner_edited = 1, updated_at = ? WHERE id = ?').run(now, intoId);
    });
    return true;
  }

  // ── The model check queue (new names only) ────────────────────────────────

  pendingPersonChecks(userKey: string, limit: number): Array<{ person_id: string; name: string; context: string | null }> {
    return this.db.prepare('SELECT person_id, name, context FROM person_checks WHERE user_key = ? ORDER BY queued_at ASC LIMIT ?')
      .all(userKey, Math.max(1, Math.min(limit, 50))) as Array<{ person_id: string; name: string; context: string | null }>;
  }

  /** Owner opt-in: queue existing unreviewed people (not owner-edited, not already decided). */
  queueExistingPersonChecks(userKey: string): number {
    const rows = this.db.prepare(`
      SELECT p.id, p.display_name,
        COALESCE(
          (SELECT b.statement FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id WHERE bp.person_id = p.id ORDER BY b.updated_at DESC LIMIT 1),
          (SELECT m.summary FROM memory_persons mp JOIN memories m ON m.id = mp.memory_id WHERE mp.person_id = p.id ORDER BY m.updated_at DESC LIMIT 1),
          ''
        ) AS context
      FROM persons p
      WHERE p.user_key = ? AND p.owner_edited = 0 AND COALESCE(p.verified_by, '') = '' AND p.kind = 'unverified'
    `).all(userKey) as Array<{ id: string; display_name: string; context: string }>;
    const put = this.db.prepare('INSERT OR IGNORE INTO person_checks (person_id, user_key, name, context, queued_at) VALUES (?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const r of rows) put.run(r.id, userKey, r.display_name, (r.context ?? '').slice(0, 400), now);
    return rows.length;
  }

  countPersonChecks(userKey: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM person_checks WHERE user_key = ?').get(userKey) as { n: number }).n;
  }

  applyPersonCheck(userKey: string, personId: string, verdict: 'person' | 'pet' | 'not_person' | 'unsure'): void {
    this.db.prepare('DELETE FROM person_checks WHERE person_id = ?').run(personId);
    const row = this.getPersonById(personId);
    if (!row || row.user_key !== userKey || row.owner_edited === 1) return;
    if (verdict === 'not_person') {
      // A model's "no" hides it; only the owner's "no" is permanent (markNotPerson).
      this.db.prepare("UPDATE persons SET kind = 'unverified', verified_by = 'model-rejected', updated_at = ? WHERE id = ?").run(Date.now(), personId);
      return;
    }
    if (verdict === 'unsure') return;
    this.db.prepare('UPDATE persons SET kind = ?, verified_by = ?, updated_at = ? WHERE id = ?').run(verdict, 'model', Date.now(), personId);
  }

  // ── The brain graph: real links only ─────────────────────────────────────

  personGraph(userKey: string, maxMemories: number): PersonGraph {
    // Nodes: the live brain (beliefs) and the people in it; edges: who appears
    // in which belief, and person-to-person relationships. Legacy archive
    // links still count toward a person's weight.
    const persons = (this.db.prepare(`
      SELECT p.id, p.display_name AS name, p.kind, p.relationship_to_user AS relationship,
        (SELECT COUNT(*) FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id AND b.status IN ('candidate','held','confirmed','contested') WHERE bp.person_id = p.id)
        + (SELECT COUNT(*) FROM memory_persons mp JOIN memories m ON m.id = mp.memory_id AND m.dismissed = 0 WHERE mp.person_id = p.id) AS memoryCount
      FROM persons p
      WHERE p.user_key = ? AND COALESCE(p.verified_by, '') != 'model-rejected'
      ORDER BY memoryCount DESC
      LIMIT 400
    `).all(userKey) as PersonGraph['persons']).filter((p) => p.memoryCount > 0 || p.relationship);
    const memories = (this.db.prepare(`
      SELECT id, statement AS summary, kind AS type, MIN(1, 0.3 + support / 8.0) AS importance, updated_at AS updatedAt FROM beliefs
      WHERE owner_key = ? AND status IN ('candidate', 'held', 'confirmed', 'contested')
      ORDER BY (status = 'confirmed') DESC, (status = 'held') DESC, updated_at DESC
      LIMIT ?
    `).all(userKey, Math.max(10, Math.min(maxMemories, 2000))) as PersonGraph['memories'])
      .map((m) => ({ ...m, summary: m.summary.length > 140 ? `${m.summary.slice(0, 137)}…` : m.summary }));
    const personIds = new Set(persons.map((p) => p.id));
    const memoryIds = new Set(memories.map((m) => m.id));
    const memoryPersons = (this.db.prepare(`
      SELECT bp.belief_id AS memoryId, bp.person_id AS personId, bp.role FROM belief_persons bp
      JOIN persons p ON p.id = bp.person_id WHERE p.user_key = ?
    `).all(userKey) as PersonGraph['memoryPersons']).filter((l) => personIds.has(l.personId) && memoryIds.has(l.memoryId));
    const relationships = (this.db.prepare(`
      SELECT source_person_id AS source, target_person_id AS target, relation_type AS type, strength FROM person_relationships WHERE user_key = ?
    `).all(userKey) as PersonGraph['relationships']).filter((r) => personIds.has(r.source) && personIds.has(r.target));
    return { persons, memories, memoryPersons, relationships };
  }

  getPersonById(id: string): PersonRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM persons WHERE id = ? LIMIT 1');
    return stmt.get(id) as PersonRow | undefined;
  }

  addPersonAlias(personId: string, alias: string, source: string = 'memory'): void {
    const normalizedAlias = this.normalizePersonName(alias);
    if (!normalizedAlias) return;
    const id = `pal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO person_aliases (id, person_id, alias, normalized_alias, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, personId, alias.trim(), normalizedAlias, source, Date.now());
  }

  linkMemoryPerson(memoryId: string, personId: string, role: string = 'mentioned', confidence: number = 0.7): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO memory_persons (memory_id, person_id, role, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, person_id)
      DO UPDATE SET role = excluded.role, confidence = excluded.confidence, updated_at = excluded.updated_at
    `);
    stmt.run(memoryId, personId, role, confidence, now, now);
  }

  clearMemoryPersons(memoryId: string): void {
    const stmt = this.db.prepare('DELETE FROM memory_persons WHERE memory_id = ?');
    stmt.run(memoryId);
  }

  clearRelationshipsByMemory(memoryId: string): void {
    const stmt = this.db.prepare('DELETE FROM person_relationships WHERE evidence_memory_id = ?');
    stmt.run(memoryId);
  }

  clearUserPersonGraph(userKey: string): void {
    const deleteRelationships = this.db.prepare('DELETE FROM person_relationships WHERE user_key = ?');
    deleteRelationships.run(userKey);

    const deleteMemoryPersons = this.db.prepare(`
      DELETE FROM memory_persons
      WHERE person_id IN (SELECT id FROM persons WHERE user_key = ?)
    `);
    deleteMemoryPersons.run(userKey);
  }

  deleteOrphanPersons(userKey: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM persons
      WHERE user_key = ?
        AND owner_edited = 0
        AND id NOT IN (SELECT DISTINCT person_id FROM memory_persons)
        AND id NOT IN (SELECT DISTINCT person_id FROM belief_persons)
    `);
    stmt.run(userKey);
  }

  upsertPersonRelationship(params: {
    userKey: string;
    sourcePersonId: string;
    targetPersonId: string;
    relationType: string;
    strength?: number;
    evidenceMemoryId?: string | null;
  }): void {
    if (params.sourcePersonId === params.targetPersonId) return;
    const now = Date.now();
    const strength = params.strength ?? 0.6;
    const relationType = params.relationType || 'related';

    const existingStmt = this.db.prepare(`
      SELECT * FROM person_relationships
      WHERE user_key = ? AND source_person_id = ? AND target_person_id = ? AND relation_type = ?
      LIMIT 1
    `);
    const existing = existingStmt.get(
      params.userKey,
      params.sourcePersonId,
      params.targetPersonId,
      relationType,
    ) as { id: string; strength: number } | undefined;

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE person_relationships
        SET strength = ?, evidence_memory_id = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(Math.max(existing.strength, strength), params.evidenceMemoryId ?? null, now, existing.id);
      return;
    }

    const id = `rel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO person_relationships (
        id, user_key, source_person_id, target_person_id, relation_type,
        strength, evidence_memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      params.userKey,
      params.sourcePersonId,
      params.targetPersonId,
      relationType,
      strength,
      params.evidenceMemoryId ?? null,
      now,
      now,
    );
  }

  listPersons(userKey: string, query?: string, limit: number = 100): PersonListRow[] {
    const cappedLimit = Math.min(Math.max(limit, 1), 5000);
    // Counts both the legacy archive and live beliefs; owner-edited people
    // stay listed even with nothing linked yet.
    const q = query && query.trim() ? `%${query.trim().toLowerCase()}%` : null;
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT p.*, (SELECT COUNT(*) FROM memory_persons mp JOIN memories m ON m.id = mp.memory_id AND m.dismissed = 0 WHERE mp.person_id = p.id)
          + (SELECT COUNT(*) FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id AND b.status IN ('candidate','held','confirmed','contested') WHERE bp.person_id = p.id) AS memory_count
        FROM persons p
        WHERE p.user_key = ?
          ${q ? 'AND (LOWER(p.display_name) LIKE ? OR LOWER(p.canonical_name) LIKE ? OR p.id IN (SELECT person_id FROM person_aliases WHERE normalized_alias LIKE ?))' : ''}
      )
      WHERE memory_count > 0 OR owner_edited = 1
      ORDER BY memory_count DESC, updated_at DESC
      LIMIT ?
    `);
    return (q ? stmt.all(userKey, q, q, q, cappedLimit) : stmt.all(userKey, cappedLimit)) as PersonListRow[];
  }

  getPersonWithCount(userKey: string, personId: string): PersonListRow | undefined {
    const stmt = this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM memory_persons mp JOIN memories m ON m.id = mp.memory_id AND m.dismissed = 0 WHERE mp.person_id = p.id)
          + (SELECT COUNT(*) FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id AND b.status IN ('candidate','held','confirmed','contested') WHERE bp.person_id = p.id) AS memory_count
      FROM persons p
      WHERE p.user_key = ? AND p.id = ?
      LIMIT 1
    `);
    return stmt.get(userKey, personId) as PersonListRow | undefined;
  }

  /** Live beliefs that mention a person, newest first. */
  getBeliefIdsForPerson(personId: string, limit: number = 50, offset = 0): string[] {
    return (this.db.prepare(`SELECT bp.belief_id AS id FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id
      WHERE bp.person_id = ? AND b.status IN ('candidate','held','confirmed','contested') ORDER BY b.updated_at DESC LIMIT ? OFFSET ?`)
      .all(personId, Math.max(1, limit), Math.max(0, offset)) as Array<{ id: string }>).map((r) => r.id);
  }

  /** How many live beliefs and legacy memories mention a person (for paging). */
  countPersonMemories(userKey: string, personId: string): { beliefs: number; memories: number } {
    const beliefs = (this.db.prepare(`SELECT COUNT(*) AS n FROM belief_persons bp JOIN beliefs b ON b.id = bp.belief_id
      WHERE bp.person_id = ? AND b.status IN ('candidate','held','confirmed','contested')`).get(personId) as { n: number }).n;
    const memories = (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_persons mp JOIN memories m ON m.id = mp.memory_id
      WHERE mp.person_id = ? AND m.user_key = ? AND m.dismissed = 0`).get(personId, userKey) as { n: number }).n;
    return { beliefs, memories };
  }

  getPersonConnections(userKey: string, personId: string, limit: number = 30): PersonConnectionRow[] {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.display_name,
        pr.relation_type,
        pr.strength
      FROM person_relationships pr
      JOIN persons p ON p.id = pr.target_person_id
      WHERE pr.user_key = ? AND pr.source_person_id = ?
      ORDER BY pr.strength DESC, p.display_name ASC
      LIMIT ?
    `);
    return stmt.all(userKey, personId, cappedLimit) as PersonConnectionRow[];
  }

  getMemoriesForPerson(userKey: string, personId: string, limit: number = 50, offset = 0): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM memory_persons mp
      JOIN memories m ON m.id = mp.memory_id
      WHERE mp.person_id = ? AND m.user_key = ? AND m.dismissed = 0
      ORDER BY m.updated_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(personId, userKey, Math.max(1, limit), Math.max(0, offset)) as MemoryRow[];
  }

  getRelationshipMemoryRows(userKey: string): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_key = ? AND dismissed = 0 AND type IN ('relationship', 'episode', 'identity', 'project')
      ORDER BY updated_at DESC
    `);
    return stmt.all(userKey) as MemoryRow[];
  }

  private normalizePersonName(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9@\s'-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The legacy archive as map notes (live rows only). */
  archiveNotes(userKey: string, limit = 50000): Array<{ id: string; text: string; kind: string; at: number; confidence: number }> {
    return this.db.prepare(`SELECT id, summary AS text, type AS kind, updated_at AS at, confidence FROM memories
      WHERE user_key = ? AND dismissed = 0 AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT ?`).all(userKey, limit) as Array<{ id: string; text: string; kind: string; at: number; confidence: number }>;
  }

  /** Changes when any live belief or archive row changes: count + newest update. */
  knowledgeSignature(userKey: string, ownerKey: string, archive: boolean): string {
    const b = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM beliefs WHERE owner_key = ? AND status IN ('candidate','held','confirmed','contested')`).get(ownerKey) as { n: number; t: number };
    if (!archive) return `${b.n}:${b.t}`;
    const m = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM memories WHERE user_key = ? AND dismissed = 0 AND superseded_by IS NULL`).get(userKey) as { n: number; t: number };
    return `${b.n}:${b.t}|${m.n}:${m.t}`;
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
    const stmt = this.db.prepare(`SELECT type, COUNT(*) as count FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active', 'durable') GROUP BY type`);
    const rows = stmt.all(userKey) as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  totalActive(userKey: string): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active', 'durable')`);
    const row = stmt.get(userKey) as { count: number };
    return row.count;
  }

  /** Rows the belief migration set aside as junk (ADR-026 §3.7): hidden from prompts, shown on the dashboard for review. */
  listQuarantined(userKey: string, limit: number = 500): MemoryRow[] {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND scope = 'quarantine' AND dismissed = 0 ORDER BY updated_at DESC LIMIT ?`);
    return stmt.all(userKey, limit) as MemoryRow[];
  }

  /** The owner reviewed a quarantined row and wants it back: it becomes a durable memory again. */
  restoreQuarantined(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`UPDATE memories SET scope = 'durable', dismissed = 0, provenance = 'restored', updated_at = ?, last_seen_at = ? WHERE id = ? AND scope = 'quarantine'`);
    return stmt.run(now, now, id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
