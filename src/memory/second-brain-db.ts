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
  } catch {
    syncDatabaseClass = null;
  }
} catch {
  syncDatabaseClass = null;
}

export function isBetterSqlite3Available(): boolean {
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

export class SecondBrainDB {
  private db: BetterSqlite3Database;

  constructor(dbPath: string) {
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

  upsertPerson(params: {
    userKey: string;
    name: string;
    relationshipToUser?: string | null;
    confidence?: number;
    description?: string | null;
    personId?: string;
  }): PersonRow {
    const now = Date.now();
    const normalized = this.normalizePersonName(params.name);
    const existingStmt = this.db.prepare('SELECT * FROM persons WHERE user_key = ? AND canonical_name = ? LIMIT 1');
    const existing = existingStmt.get(params.userKey, normalized) as PersonRow | undefined;

    if (existing) {
      const confidence = Math.max(existing.confidence, params.confidence ?? existing.confidence);
      const relationshipToUser = params.relationshipToUser ?? existing.relationship_to_user;
      const description = params.description ?? existing.description;
      this.db.prepare(`
        UPDATE persons
        SET display_name = ?, relationship_to_user = ?, description = ?, confidence = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `).run(params.name.trim(), relationshipToUser, description, confidence, now, now, existing.id);

      const updated = this.getPersonById(existing.id);
      if (!updated) throw new Error('Failed to update person record');
      return updated;
    }

    const id = params.personId || `per_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const confidence = params.confidence ?? 0.7;
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
        AND id NOT IN (SELECT DISTINCT person_id FROM memory_persons)
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
    const cappedLimit = Math.min(Math.max(limit, 1), 300);
    if (query && query.trim()) {
      const q = `%${query.trim().toLowerCase()}%`;
      const stmt = this.db.prepare(`
        SELECT
          p.*,
          COUNT(DISTINCT mp.memory_id) AS memory_count
        FROM persons p
        LEFT JOIN memory_persons mp ON mp.person_id = p.id
        LEFT JOIN memories m ON m.id = mp.memory_id
        WHERE p.user_key = ?
          AND (LOWER(p.display_name) LIKE ? OR LOWER(p.canonical_name) LIKE ?)
          AND (m.id IS NULL OR m.dismissed = 0)
        GROUP BY p.id
        HAVING COUNT(DISTINCT mp.memory_id) > 0
        ORDER BY memory_count DESC, p.updated_at DESC
        LIMIT ?
      `);
      return stmt.all(userKey, q, q, cappedLimit) as PersonListRow[];
    }

    const stmt = this.db.prepare(`
      SELECT
        p.*,
        COUNT(DISTINCT mp.memory_id) AS memory_count
      FROM persons p
      LEFT JOIN memory_persons mp ON mp.person_id = p.id
      LEFT JOIN memories m ON m.id = mp.memory_id
      WHERE p.user_key = ?
        AND (m.id IS NULL OR m.dismissed = 0)
      GROUP BY p.id
      HAVING COUNT(DISTINCT mp.memory_id) > 0
      ORDER BY memory_count DESC, p.updated_at DESC
      LIMIT ?
    `);
    return stmt.all(userKey, cappedLimit) as PersonListRow[];
  }

  getPersonWithCount(userKey: string, personId: string): PersonListRow | undefined {
    const stmt = this.db.prepare(`
      SELECT
        p.*,
        COUNT(DISTINCT mp.memory_id) AS memory_count
      FROM persons p
      LEFT JOIN memory_persons mp ON mp.person_id = p.id
      LEFT JOIN memories m ON m.id = mp.memory_id
      WHERE p.user_key = ?
        AND p.id = ?
        AND (m.id IS NULL OR m.dismissed = 0)
      GROUP BY p.id
      LIMIT 1
    `);
    return stmt.get(userKey, personId) as PersonListRow | undefined;
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

  getMemoriesForPerson(userKey: string, personId: string, limit: number = 50): MemoryRow[] {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM memory_persons mp
      JOIN memories m ON m.id = mp.memory_id
      WHERE mp.person_id = ? AND m.user_key = ? AND m.dismissed = 0
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    return stmt.all(personId, userKey, cappedLimit) as MemoryRow[];
  }

  getRelationshipMemoryRows(userKey: string): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_key = ? AND dismissed = 0 AND type IN ('relationship', 'episode')
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
