/**
 * Beliefs: what Mercury thinks it knows about its owner, with evidence.
 *
 * A belief is a claim ("prefers one command over many manual steps") held
 * with a confidence that comes from counted evidence for and against it,
 * decays unless re-supported, applies in a context, and has a validity
 * window. Nothing is deleted: a belief that stops being true is retired or
 * superseded, and the owner can see why. Design: docs/owner-model.md (ADR-026).
 *
 * The tables live in the Second Brain database next to the legacy
 * `memories` table, which keeps the people graph and the dashboard's
 * history; the per-turn and reflection learning loops write here.
 */
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../utils/sqlite-driver.js';
import { logger } from '../utils/logger.js';
import { looksLikeIdentity } from '../learning/text.js';

export type BeliefKind = 'fact' | 'preference' | 'trait' | 'situation' | 'relationship' | 'goal' | 'project' | 'episode';
export type BeliefStatus = 'candidate' | 'held' | 'confirmed' | 'contested' | 'retired' | 'forgotten';
export type BeliefTimescale = 'stable' | 'situational' | 'episodic';
export type EvidenceKind = 'said' | 'corrected' | 'approved' | 'denied' | 'reacted' | 'observed' | 'acted-on-ok' | 'owner' | 'reflection' | 'migration';

/** The working-trait dimensions the reflection pass infers (docs/owner-model.md §3.2). */
export const TRAIT_DIMENSIONS = {
  brevity: ['terse', 'balanced', 'thorough'],
  autonomy: ['ask-first', 'ask-when-risky', 'just-do-it'],
  'decision-style': ['options', 'recommendation', 'decide-for-me'],
  formality: ['casual', 'neutral', 'formal'],
  'feedback-style': ['blunt', 'explains', 'silent-redo'],
  rhythm: ['morning', 'daytime', 'evening', 'late-night'],
} as const;
/** Dimensions with a free suffix: `expertise:typescript`, `risk:publishing`. */
export const SCOPED_DIMENSIONS = {
  expertise: ['novice', 'competent', 'expert'],
  risk: ['cautious', 'normal', 'bold'],
} as const;

export interface Belief {
  id: string;
  ownerKey: string;
  kind: BeliefKind;
  /** Traits only: the dimension (e.g. `brevity`, `risk:publishing`). */
  dimension: string | null;
  /** Traits only: the inferred level on that dimension. */
  level: string | null;
  statement: string;
  detail: string | null;
  /** Where it applies: `*`, `channel:telegram`, `project:<cwd>`, `domain:video`… */
  context: string;
  support: number;
  against: number;
  /** Distinct sessions that supported it (a belief is held only after two). */
  supportSessions: number;
  timescale: BeliefTimescale;
  status: BeliefStatus;
  ownerStated: boolean;
  validFrom: number;
  validTo: number | null;
  supersededBy: string | null;
  lastSupportedAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Offered to the cloud shared pool (the owner's share-learning toggle). */
  shareable: boolean;
}

export interface Evidence {
  id: string;
  beliefId: string;
  kind: EvidenceKind;
  sessionId: string | null;
  turnRef: string | null;
  excerpt: string;
  weight: number;
  at: number;
}

export interface BeliefOperation {
  op: 'create' | 'support' | 'contradict' | 'owner_stated' | 'correction';
  /** For support/contradict/correction: the belief it refers to (by id). */
  beliefId?: string;
  kind?: BeliefKind;
  dimension?: string;
  level?: string;
  statement?: string;
  detail?: string;
  context?: string;
  timescale?: BeliefTimescale;
  /** What the owner said or did that is the evidence (≤ 200 chars). */
  excerpt: string;
  evidenceKind?: EvidenceKind;
  weight?: number;
  sessionId?: string;
  turnRef?: string;
  shareable?: boolean;
}

export interface ApplyResult {
  belief: Belief;
  /** What happened, in words the announcer can use. */
  change: 'created' | 'supported' | 'now-held' | 'contradicted' | 'contested' | 'confirmed' | 'replaced' | 'unchanged';
  /** True when this change should alter how Mercury behaves from now on. */
  behaviorChanging: boolean;
  /** The belief this one replaced (corrections). */
  replaced?: Belief;
}

const HALF_LIFE_DAYS: Record<BeliefTimescale, number> = { stable: 60, situational: 0.5, episodic: 30 };
/** Stable beliefs fade at different speeds: who the owner is barely changes; how they want to work does. */
const KIND_HALF_LIFE_DAYS: Partial<Record<BeliefKind, number>> = { fact: 365, relationship: 365, preference: 120, goal: 90, project: 90, trait: 60 };
function halfLifeDays(b: Belief): number {
  return b.timescale === 'stable' ? (KIND_HALF_LIFE_DAYS[b.kind] ?? HALF_LIFE_DAYS.stable) : HALF_LIFE_DAYS[b.timescale];
}
const DAY = 86_400_000;
export const RETIRE_BELOW = 0.35;

/** Words that match almost every belief and only add noise to an OR query. */
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'were', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'not', 'but', 'all', 'any', 'some', 'just', 'like', 'about', 'from', 'into', 'than', 'then', 'them', 'they', 'their', 'there', 'here', 'also', 'very', 'much', 'more', 'most', 'does', 'did', 'doing', 'done', 'please', 'thanks', 'okay', 'yeah', 'hey', 'want', 'need', 'make', 'get', 'got', 'let', 'use', 'using', 'one', 'two', 'now', 'out', 'its', 'our', 'mine', 'yours', 'me', 'my', 'we', 'us', 'it', 'is', 'be', 'do', 'to', 'of', 'in', 'on', 'at', 'by', 'or', 'an', 'as', 'if', 'so', 'no', 'up', 'am']);

/** An FTS5 OR-query from free text: lower-cased, punctuation out, stopwords out, deduped, capped. */
export function ftsMatch(text: string, opts: { minLength?: number; max?: number } = {}): string | null {
  const minLength = opts.minLength ?? 3;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (raw.length < minLength || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= (opts.max ?? 24)) break;
  }
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ');
}
const HELD_AT_SESSIONS = 2;

interface BeliefRow {
  id: string; owner_key: string; kind: BeliefKind; dimension: string | null; level: string | null;
  statement: string; detail: string | null; context: string; support: number; against: number;
  support_sessions: number; timescale: BeliefTimescale; status: BeliefStatus; owner_stated: number;
  valid_from: number; valid_to: number | null; superseded_by: string | null; last_supported_at: number;
  last_used_at: number | null; created_at: number; updated_at: number; shareable?: number;
}

export class BeliefStore {
  constructor(private db: SqliteDatabase, private ownerKey: string = 'user:owner') {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS beliefs (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        dimension TEXT,
        level TEXT,
        statement TEXT NOT NULL,
        detail TEXT,
        context TEXT NOT NULL DEFAULT '*',
        support REAL NOT NULL DEFAULT 0,
        against REAL NOT NULL DEFAULT 0,
        support_sessions INTEGER NOT NULL DEFAULT 0,
        timescale TEXT NOT NULL DEFAULT 'stable',
        status TEXT NOT NULL DEFAULT 'candidate',
        owner_stated INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        superseded_by TEXT,
        last_supported_at INTEGER NOT NULL,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_beliefs_owner_status ON beliefs(owner_key, status);
      CREATE INDEX IF NOT EXISTS idx_beliefs_owner_dim ON beliefs(owner_key, dimension, context);
      CREATE VIRTUAL TABLE IF NOT EXISTS beliefs_fts USING fts5(statement, detail, content=beliefs, content_rowid=rowid);
      CREATE TRIGGER IF NOT EXISTS beliefs_ai AFTER INSERT ON beliefs BEGIN
        INSERT INTO beliefs_fts(rowid, statement, detail) VALUES (new.rowid, new.statement, new.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS beliefs_ad AFTER DELETE ON beliefs BEGIN
        INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, detail) VALUES('delete', old.rowid, old.statement, old.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS beliefs_au AFTER UPDATE ON beliefs BEGIN
        INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, detail) VALUES('delete', old.rowid, old.statement, old.detail);
        INSERT INTO beliefs_fts(rowid, statement, detail) VALUES (new.rowid, new.statement, new.detail);
      END;
      CREATE TABLE IF NOT EXISTS belief_evidence (
        id TEXT PRIMARY KEY,
        belief_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        turn_ref TEXT,
        excerpt TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        at INTEGER NOT NULL,
        FOREIGN KEY (belief_id) REFERENCES beliefs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_belief_evidence_belief ON belief_evidence(belief_id, at);
      CREATE TABLE IF NOT EXISTS belief_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const cols = this.db.prepare('PRAGMA table_info(beliefs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'shareable')) this.db.exec('ALTER TABLE beliefs ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0');
  }

  // ── confidence ─────────────────────────────────────────────────────────

  /** Beta-mean of the evidence, decayed by time since the last support. Confirmed/owner-stated beliefs don't decay. */
  confidence(b: Belief, now = Date.now()): number {
    const mean = (b.support + 1) / (b.support + b.against + 2);
    if (b.ownerStated || b.status === 'confirmed') return Math.min(0.98, Math.max(mean, 0.85));
    const ageDays = Math.max(0, now - b.lastSupportedAt) / DAY;
    const decay = Math.pow(0.5, ageDays / halfLifeDays(b));
    return mean * decay;
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** Apply one belief operation from the learning loops. */
  apply(op: BeliefOperation, now = Date.now()): ApplyResult | null {
    const weight = op.weight ?? 1;
    if (op.op === 'create' || op.op === 'owner_stated') {
      if (!op.statement || !op.kind) return null;
      const existing = this.findSameClaim(op.statement, op.kind, op.context ?? '*', op.dimension);
      if (existing) {
        if (op.op !== 'owner_stated') return this.apply({ ...op, op: 'support', beliefId: existing.id, statement: undefined }, now);
        // The owner stated a claim Mercury already held or suspected: confirm it (once).
        if (existing.ownerStated || existing.status === 'confirmed') return { belief: existing, change: 'unchanged', behaviorChanging: false };
        this.update(existing.id, { status: 'confirmed', ownerStated: true, support: existing.support + weight, lastSupportedAt: now, validTo: null }, now);
        this.addEvidence(existing.id, op.evidenceKind ?? 'owner', op, weight, now);
        for (const rival of this.rivals(this.get(existing.id)!)) this.update(rival.id, { status: 'retired', validTo: now, supersededBy: existing.id }, now);
        const belief = this.get(existing.id)!;
        return { belief, change: 'confirmed', behaviorChanging: isBehavioral(belief) };
      }
      const ownerStated = op.op === 'owner_stated';
      const belief = this.insert({
        kind: op.kind, dimension: op.dimension ?? null, level: op.level ?? null, statement: op.statement.trim(),
        detail: op.detail?.trim() ?? null, context: op.context ?? '*', timescale: op.timescale ?? (op.kind === 'situation' ? 'situational' : op.kind === 'episode' ? 'episodic' : 'stable'),
        support: weight, against: 0, supportSessions: op.sessionId ? 1 : 0, ownerStated,
        status: ownerStated ? 'confirmed' : 'candidate', shareable: op.shareable === true,
      }, now);
      this.addEvidence(belief.id, op.evidenceKind ?? (ownerStated ? 'owner' : 'said'), op, weight, now);
      this.settleContest(belief, now);
      return { belief: this.get(belief.id)!, change: ownerStated ? 'confirmed' : 'created', behaviorChanging: ownerStated && isBehavioral(belief) };
    }
    const target = op.beliefId ? this.get(op.beliefId) : null;
    if (!target || target.status === 'forgotten') return null;
    if (op.op === 'support') {
      const newSession = op.sessionId ? !this.sessionSupported(target.id, op.sessionId) : false;
      const supportSessions = target.supportSessions + (newSession ? 1 : 0);
      const wasHeld = target.status === 'held' || target.status === 'confirmed';
      let status = target.status;
      if (status === 'candidate' && (supportSessions >= HELD_AT_SESSIONS || target.ownerStated)) status = 'held';
      if (status === 'retired') status = supportSessions >= HELD_AT_SESSIONS ? 'held' : 'candidate';
      this.update(target.id, { support: target.support + weight, supportSessions, status, lastSupportedAt: now, validTo: null }, now);
      this.addEvidence(target.id, op.evidenceKind ?? 'said', op, weight, now);
      const belief = this.get(target.id)!;
      const nowHeld = !wasHeld && status === 'held';
      return { belief, change: nowHeld ? 'now-held' : 'supported', behaviorChanging: nowHeld && isBehavioral(belief) };
    }
    if (op.op === 'contradict') {
      const against = target.against + weight;
      let status = target.status;
      if (target.status === 'confirmed' || target.ownerStated) {
        // What the owner said stands until they say otherwise; log the counter-evidence only.
      } else if (target.status === 'held' && against >= 1.5) status = 'contested';
      else if (target.status === 'candidate' && against >= target.support) status = 'retired';
      this.update(target.id, { against, status, validTo: status === 'retired' ? now : target.validTo }, now);
      this.addEvidence(target.id, op.evidenceKind ?? 'corrected', op, weight, now);
      const belief = this.get(target.id)!;
      return { belief, change: status === 'contested' ? 'contested' : 'contradicted', behaviorChanging: status === 'contested' && isBehavioral(belief) };
    }
    if (op.op === 'correction') {
      // The owner corrected a belief: retire it and hold the replacement as owner-stated.
      if (!op.statement) return this.apply({ ...op, op: 'contradict', weight: 2, evidenceKind: 'corrected' }, now);
      this.update(target.id, { status: 'retired', validTo: now, against: target.against + 2 }, now);
      this.addEvidence(target.id, 'corrected', op, 2, now);
      const replacement = this.insert({
        kind: op.kind ?? target.kind, dimension: op.dimension ?? target.dimension, level: op.level ?? null, statement: op.statement.trim(),
        detail: op.detail?.trim() ?? null, context: op.context ?? target.context, timescale: op.timescale ?? target.timescale,
        support: 2, against: 0, supportSessions: op.sessionId ? 1 : 0, ownerStated: true, status: 'confirmed', shareable: op.shareable === true || target.shareable,
      }, now);
      this.update(target.id, { supersededBy: replacement.id }, now);
      this.addEvidence(replacement.id, 'owner', op, 2, now);
      return { belief: this.get(replacement.id)!, change: 'replaced', behaviorChanging: isBehavioral(replacement), replaced: this.get(target.id)! };
    }
    return null;
  }

  /** The owner confirmed a belief ("yes, that's right"). */
  confirm(id: string, now = Date.now()): Belief | null {
    const b = this.get(id);
    if (!b || b.status === 'forgotten') return null;
    this.update(id, { status: 'confirmed', ownerStated: true, support: b.support + 2, lastSupportedAt: now, validTo: null }, now);
    this.addEvidence(id, 'owner', { excerpt: 'confirmed by the owner' }, 2, now);
    // A confirmed belief settles any contest on the same dimension/context.
    for (const rival of this.rivals(this.get(id)!)) this.update(rival.id, { status: 'retired', validTo: now, supersededBy: id }, now);
    return this.get(id);
  }

  /** The owner asked Mercury to forget it: hidden from every prompt and list, for good. */
  forget(id: string, now = Date.now()): boolean {
    const b = this.get(id);
    if (!b) return false;
    this.update(id, { status: 'forgotten', validTo: now }, now);
    this.addEvidence(id, 'owner', { excerpt: 'forgotten at the owner\'s request' }, 0, now);
    return true;
  }

  /** The owner settled a contest: the winner is confirmed, the loser retired. */
  settle(winnerId: string, loserId: string, now = Date.now()): void {
    this.confirm(winnerId, now);
    const loser = this.get(loserId);
    if (loser && loser.status !== 'forgotten') this.update(loserId, { status: 'retired', validTo: now, supersededBy: winnerId }, now);
  }

  markUsed(ids: string[], now = Date.now()): void {
    const stmt = this.db.prepare('UPDATE beliefs SET last_used_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  /** Mercury acted on these beliefs and the owner didn't object: weak support. */
  actedOnOk(ids: string[], sessionId?: string, now = Date.now()): void {
    for (const id of ids) {
      const b = this.get(id);
      if (!b || b.status === 'forgotten' || b.status === 'retired') continue;
      if (sessionId && this.sessionSupported(id, sessionId)) continue;
      this.update(id, { support: b.support + 0.25, lastSupportedAt: now }, now);
      this.addEvidence(id, 'acted-on-ok', { excerpt: 'acted on without objection', sessionId }, 0.25, now);
    }
  }

  /** Retire beliefs whose confidence decayed below the floor. Returns how many. */
  decayPass(now = Date.now()): number {
    let retired = 0;
    for (const b of this.list({ statuses: ['candidate', 'held', 'contested'] })) {
      // Retire only what faded past the floor AND was either contradicted or
      // not seen for two half-lives; a true fact nobody disputed just rests.
      const stale = (now - b.lastSupportedAt) / DAY >= 2 * halfLifeDays(b);
      if (this.confidence(b, now) < RETIRE_BELOW && (b.against > 0 || stale)) {
        this.update(b.id, { status: 'retired', validTo: now }, now);
        retired++;
      }
    }
    return retired;
  }

  // ── reads ──────────────────────────────────────────────────────────────

  get(id: string): Belief | null {
    const row = this.db.prepare('SELECT * FROM beliefs WHERE id = ? AND owner_key = ?').get(id, this.ownerKey) as BeliefRow | undefined;
    return row ? toBelief(row) : null;
  }

  list(opts: { statuses?: BeliefStatus[]; kinds?: BeliefKind[]; dimension?: string; context?: string; limit?: number } = {}): Belief[] {
    const statuses = opts.statuses ?? ['candidate', 'held', 'confirmed', 'contested'];
    const where = ['owner_key = ?', `status IN (${statuses.map(() => '?').join(',')})`];
    const params: unknown[] = [this.ownerKey, ...statuses];
    if (opts.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`); params.push(...opts.kinds); }
    if (opts.dimension) { where.push('dimension = ?'); params.push(opts.dimension); }
    if (opts.context) { where.push('context = ?'); params.push(opts.context); }
    const rows = this.db.prepare(`SELECT * FROM beliefs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params, opts.limit ?? 500) as BeliefRow[];
    return rows.map(toBelief);
  }

  /** Beliefs usable in a prompt: held or confirmed, confidence above the floor, strongest first. */
  usable(now = Date.now()): Array<Belief & { confidence: number }> {
    return this.list({ statuses: ['held', 'confirmed'] })
      .map((b) => ({ ...b, confidence: this.confidence(b, now) }))
      .filter((b) => b.confidence >= RETIRE_BELOW)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Beliefs relevant to a message (FTS over statement + detail). Held and
   * confirmed ones come first; when there is room, candidates follow (the
   * caller labels them unverified). Without the candidates, everything
   * learned today — and every migrated memory — would be invisible to chat
   * until a later session supported it.
   */
  searchRelevant(query: string, limit = 5, now = Date.now()): Array<Belief & { confidence: number }> {
    const match = ftsMatch(query);
    if (!match) return [];
    const run = (statuses: BeliefStatus[], n: number): Array<Belief & { confidence: number }> => {
      try {
        const rows = this.db.prepare(`
          SELECT b.* FROM beliefs_fts f JOIN beliefs b ON b.rowid = f.rowid
          WHERE beliefs_fts MATCH ? AND b.owner_key = ? AND b.status IN (${statuses.map(() => '?').join(',')})
          ORDER BY bm25(beliefs_fts) LIMIT ?`).all(match, this.ownerKey, ...statuses, n) as BeliefRow[];
        return rows.map(toBelief)
          .map((b) => ({ ...b, confidence: this.confidence(b, now) }))
          .filter((b) => b.confidence >= RETIRE_BELOW);
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'belief FTS query failed');
        return [];
      }
    };
    const sure = run(['held', 'confirmed'], limit * 3).slice(0, limit);
    if (sure.length >= limit) return sure;
    const seen = new Set(sure.map((b) => b.id));
    const maybe = run(['candidate'], limit * 3).filter((b) => !seen.has(b.id)).slice(0, limit - sure.length);
    return [...sure, ...maybe];
  }

  /** The strongest beliefs overall, for "what do you know about me?": sure ones first, then candidates. */
  strongest(limit = 12, now = Date.now()): Array<Belief & { confidence: number }> {
    const sure = this.usable(now).slice(0, limit);
    if (sure.length >= limit) return sure;
    const maybe = this.list({ statuses: ['candidate'], limit: 200 })
      .map((b) => ({ ...b, confidence: this.confidence(b, now) }))
      .filter((b) => b.confidence >= RETIRE_BELOW)
      .sort((a, b) => b.confidence - a.confidence || b.lastSupportedAt - a.lastSupportedAt)
      .slice(0, limit - sure.length);
    return [...sure, ...maybe];
  }

  /** Candidates that may be the same claim (for the merge judge). */
  findSimilar(statement: string, kind?: BeliefKind, limit = 5): Belief[] {
    const match = ftsMatch(statement, { minLength: 4, max: 16 });
    if (!match) return [];
    try {
      const rows = this.db.prepare(`
        SELECT b.* FROM beliefs_fts f JOIN beliefs b ON b.rowid = f.rowid
        WHERE beliefs_fts MATCH ? AND b.owner_key = ? AND b.status != 'forgotten' ${kind ? 'AND b.kind = ?' : ''}
        ORDER BY bm25(beliefs_fts) LIMIT ?`).all(...(kind ? [match, this.ownerKey, kind, limit] : [match, this.ownerKey, limit])) as BeliefRow[];
      return rows.map(toBelief);
    } catch {
      return [];
    }
  }

  /** Beliefs learned or changed since `since`, newest first (the "what I learned" view). */
  recentlyLearned(since: number, limit = 20): Belief[] {
    const rows = this.db.prepare(`SELECT * FROM beliefs WHERE owner_key = ? AND status != 'forgotten' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`).all(this.ownerKey, since, limit) as BeliefRow[];
    return rows.map(toBelief);
  }

  /** Contested pairs: two live beliefs on the same dimension and context with different levels, or one marked contested. */
  contested(): Array<{ a: Belief; b: Belief | null }> {
    const out: Array<{ a: Belief; b: Belief | null }> = [];
    const seen = new Set<string>();
    for (const a of this.list({ statuses: ['contested'] })) {
      if (seen.has(a.id)) continue;
      const rival = this.rivals(a)[0] ?? null;
      if (rival) seen.add(rival.id);
      seen.add(a.id);
      out.push({ a, b: rival });
    }
    return out;
  }

  evidenceFor(beliefId: string, limit = 10): Evidence[] {
    const rows = this.db.prepare('SELECT * FROM belief_evidence WHERE belief_id = ? ORDER BY at DESC LIMIT ?').all(beliefId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: String(r.id), beliefId: String(r.belief_id), kind: r.kind as EvidenceKind, sessionId: (r.session_id as string | null) ?? null, turnRef: (r.turn_ref as string | null) ?? null, excerpt: String(r.excerpt), weight: Number(r.weight), at: Number(r.at) }));
  }

  counts(): Record<BeliefStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) as n FROM beliefs WHERE owner_key = ? GROUP BY status').all(this.ownerKey) as Array<{ status: BeliefStatus; n: number }>;
    const out: Record<BeliefStatus, number> = { candidate: 0, held: 0, confirmed: 0, contested: 0, retired: 0, forgotten: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM belief_meta WHERE key = ?').get(`${this.ownerKey}:${key}`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO belief_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${this.ownerKey}:${key}`, value);
  }

  /**
   * Two beliefs are the same claim (the reflection pass decided): the loser is
   * retired and superseded by the keeper, and its support, sessions and
   * owner-stated status move to the keeper. Returns the keeper, or null when
   * either side is missing, forgotten, or they are the same belief.
   */
  merge(keepId: string, mergeId: string, now = Date.now()): Belief | null {
    if (keepId === mergeId) return null;
    const keep = this.get(keepId);
    const lose = this.get(mergeId);
    if (!keep || !lose || keep.status === 'forgotten' || lose.status === 'forgotten') return null;
    if (lose.status === 'retired' && lose.supersededBy === keep.id) return keep;
    const ownerStated = keep.ownerStated || lose.ownerStated;
    const supportSessions = keep.supportSessions + lose.supportSessions;
    let status = keep.status;
    if (ownerStated) status = 'confirmed';
    else if (status === 'candidate' && supportSessions >= HELD_AT_SESSIONS) status = 'held';
    else if (status === 'retired') status = supportSessions >= HELD_AT_SESSIONS ? 'held' : 'candidate';
    this.db.transaction(() => {
      this.update(keep.id, {
        support: keep.support + lose.support, against: keep.against + lose.against, supportSessions, ownerStated, status,
        lastSupportedAt: Math.max(keep.lastSupportedAt, lose.lastSupportedAt), validTo: null,
      }, now);
      this.addEvidence(keep.id, 'reflection', { excerpt: `merged with "${lose.statement}"` }, lose.support, now);
      this.update(lose.id, { status: 'retired', validTo: now, supersededBy: keep.id }, now);
    });
    return this.get(keep.id);
  }

  // ── facade support (UserMemoryStore delegates here; ADR-026 single source) ──

  /** Live beliefs (any status except retired/forgotten), newest first. */
  recent(limit = 10): Belief[] {
    return this.list({ limit });
  }

  /** FTS over statements and details for the given statuses (candidates included by default). */
  search(query: string, limit = 10, statuses: BeliefStatus[] = ['candidate', 'held', 'confirmed', 'contested']): Belief[] {
    const match = ftsMatch(query);
    if (!match) return [];
    try {
      const rows = this.db.prepare(`
        SELECT b.* FROM beliefs_fts f JOIN beliefs b ON b.rowid = f.rowid
        WHERE beliefs_fts MATCH ? AND b.owner_key = ? AND b.status IN (${statuses.map(() => '?').join(',')})
        ORDER BY bm25(beliefs_fts) LIMIT ?`).all(match, this.ownerKey, ...statuses, limit) as BeliefRow[];
      return rows.map(toBelief);
    } catch {
      return [];
    }
  }

  setShareable(id: string, shareable: boolean, now = Date.now()): boolean {
    if (!this.get(id)) return false;
    this.update(id, { shareable }, now);
    return true;
  }

  shareable(limit = 50): Belief[] {
    const rows = this.db.prepare(`SELECT * FROM beliefs WHERE owner_key = ? AND shareable = 1 AND status NOT IN ('forgotten','retired') ORDER BY updated_at DESC LIMIT ?`).all(this.ownerKey, limit) as BeliefRow[];
    return rows.map(toBelief);
  }

  shareableSince(since: number, limit = 500): Belief[] {
    const rows = this.db.prepare(`SELECT * FROM beliefs WHERE owner_key = ? AND shareable = 1 AND status NOT IN ('forgotten','retired') AND updated_at > ? ORDER BY updated_at ASC LIMIT ?`).all(this.ownerKey, since, limit) as BeliefRow[];
    return rows.map(toBelief);
  }

  countShareable(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM beliefs WHERE owner_key = ? AND shareable = 1 AND status NOT IN ('forgotten','retired')`).get(this.ownerKey) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  countsByKind(): Record<string, number> {
    const rows = this.db.prepare(`SELECT kind, COUNT(*) as n FROM beliefs WHERE owner_key = ? AND status IN ('candidate','held','confirmed','contested') GROUP BY kind`).all(this.ownerKey) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  /** The owner edited a belief by hand (dashboard): the text changes, the owner's word is final. */
  edit(id: string, patch: { statement?: string; detail?: string | null; kind?: BeliefKind; context?: string }, now = Date.now()): Belief | null {
    const b = this.get(id);
    if (!b || b.status === 'forgotten') return null;
    const changes: Parameters<BeliefStore['update']>[1] = {};
    if (patch.statement && patch.statement.trim().length >= 4) changes.statement = patch.statement.trim();
    if (patch.detail !== undefined) changes.detail = patch.detail;
    if (patch.kind) changes.kind = patch.kind;
    if (patch.context) changes.context = patch.context;
    if (Object.keys(changes).length === 0) return b;
    this.update(id, { ...changes, ownerStated: true, status: b.status === 'retired' ? 'confirmed' : (b.status === 'candidate' || b.status === 'held' || b.status === 'contested' ? 'confirmed' : b.status), lastSupportedAt: now }, now);
    this.addEvidence(id, 'owner', { excerpt: 'edited by the owner' }, 1, now);
    return this.get(id);
  }

  /** Everything about this owner, gone. Used by "Clear All Memories". */
  clearAll(): number {
    const n = this.db.prepare('SELECT COUNT(*) as n FROM beliefs WHERE owner_key = ?').get(this.ownerKey) as { n: number } | undefined;
    this.db.prepare('DELETE FROM belief_evidence WHERE belief_id IN (SELECT id FROM beliefs WHERE owner_key = ?)').run(this.ownerKey);
    this.db.prepare('DELETE FROM beliefs WHERE owner_key = ?').run(this.ownerKey);
    this.db.prepare('DELETE FROM belief_meta WHERE key LIKE ?').run(`${this.ownerKey}:brief%`);
    return Number(n?.n ?? 0);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private findSameClaim(statement: string, kind: BeliefKind, context: string, dimension?: string): Belief | null {
    const norm = normalizeClaim(statement);
    for (const b of this.findSimilar(statement, kind, 8)) {
      if (b.status === 'forgotten' || b.status === 'retired') continue;
      if (b.context !== context) continue;
      if (dimension && b.dimension !== dimension) continue;
      if (normalizeClaim(b.statement) === norm || tokenOverlap(norm, normalizeClaim(b.statement)) >= 0.8) return b;
    }
    return null;
  }

  /** Live beliefs on the same dimension and context with a different level. */
  private rivals(b: Belief): Belief[] {
    if (!b.dimension) return [];
    return this.list({ dimension: b.dimension, context: b.context })
      .filter((o) => o.id !== b.id && o.level !== b.level);
  }

  /** A new trait level that disagrees with a held one on the same dimension/context makes both contested. */
  private settleContest(b: Belief, now: number): void {
    if (!b.dimension || !b.level) return;
    for (const rival of this.rivals(b)) {
      if (b.ownerStated) {
        this.update(rival.id, { status: 'retired', validTo: now, supersededBy: b.id }, now);
      } else if (rival.ownerStated || rival.status === 'confirmed') {
        this.update(b.id, { status: 'retired', validTo: now, supersededBy: rival.id }, now);
      } else if (rival.status === 'held' || rival.status === 'contested') {
        this.update(rival.id, { status: 'contested' }, now);
        this.update(b.id, { status: 'contested' }, now);
      }
    }
  }

  private sessionSupported(beliefId: string, sessionId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM belief_evidence WHERE belief_id = ? AND session_id = ? AND weight > 0 LIMIT 1').get(beliefId, sessionId);
    return !!row;
  }

  private insert(b: Omit<Belief, 'id' | 'ownerKey' | 'validFrom' | 'validTo' | 'supersededBy' | 'lastSupportedAt' | 'lastUsedAt' | 'createdAt' | 'updatedAt' | 'shareable'> & { shareable?: boolean }, now: number): Belief {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO beliefs (id, owner_key, kind, dimension, level, statement, detail, context, support, against, support_sessions, timescale, status, owner_stated, valid_from, valid_to, superseded_by, last_supported_at, last_used_at, created_at, updated_at, shareable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`)
      .run(id, this.ownerKey, b.kind, b.dimension, b.level, b.statement, b.detail, b.context, b.support, b.against, b.supportSessions, b.timescale, b.status, b.ownerStated ? 1 : 0, now, now, now, now, b.shareable ? 1 : 0);
    return this.get(id)!;
  }

  private update(id: string, patch: Partial<Pick<Belief, 'support' | 'against' | 'supportSessions' | 'status' | 'ownerStated' | 'validTo' | 'supersededBy' | 'lastSupportedAt' | 'level' | 'statement' | 'detail' | 'kind' | 'context' | 'shareable'>>, now = Date.now()): void {
    const cols: Record<string, string> = { support: 'support', against: 'against', supportSessions: 'support_sessions', status: 'status', ownerStated: 'owner_stated', validTo: 'valid_to', supersededBy: 'superseded_by', lastSupportedAt: 'last_supported_at', level: 'level', statement: 'statement', detail: 'detail', kind: 'kind', context: 'context', shareable: 'shareable' };
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    params.push(id);
    this.db.prepare(`UPDATE beliefs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private addEvidence(beliefId: string, kind: EvidenceKind, op: { excerpt: string; sessionId?: string; turnRef?: string }, weight: number, now: number): void {
    this.db.prepare('INSERT INTO belief_evidence (id, belief_id, kind, session_id, turn_ref, excerpt, weight, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), beliefId, kind, op.sessionId ?? null, op.turnRef ?? null, op.excerpt.slice(0, 200), weight, now);
  }

  // ── migration from the legacy memories table ───────────────────────────

  /**
   * One-time: quarantine junk rows (Mercury's own replies and prose fragments
   * saved as the owner's preferences) and turn the rest into beliefs. Junk is
   * hidden (scope 'quarantine'), never deleted: the dashboard lists it.
   */
  migrationDone(): boolean {
    return this.getMeta('legacy_migrated') === '1';
  }

  /** Rows the pre-Owner-Model Second Brain holds for this owner (0 on a fresh install). */
  legacyRowCount(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as n FROM memories WHERE user_key = ?').get(this.ownerKey) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  }

  migrateLegacyMemories(now = Date.now()): { quarantined: number; converted: number; skipped: boolean } {
    if (this.getMeta('legacy_migrated') === '1') return { quarantined: 0, converted: 0, skipped: true };
    const rows = this.db.prepare(`SELECT * FROM memories WHERE user_key = ? AND dismissed = 0 AND scope IN ('active','durable','subconscious')`).all(this.ownerKey) as Array<Record<string, unknown>>;
    let quarantined = 0; let converted = 0;
    const quarantine = this.db.prepare(`UPDATE memories SET scope = 'quarantine', provenance = ?, updated_at = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const r of rows) {
        const summary = String(r.summary ?? '');
        if (isLegacyJunk(r)) {
          quarantine.run('migration:junk', now, String(r.id));
          quarantined++;
          continue;
        }
        // Who the owner is lives in the config (identity.owner), one source;
        // legacy rows that only restate a name, email or handle wait in
        // quarantine rather than becoming a second, often contradictory, copy.
        if (looksLikeIdentity(String(r.summary ?? ''))) {
          quarantine.run('migration:identity', now, String(r.id));
          quarantined++;
          continue;
        }
        const kind = legacyKind(String(r.type));
        if (!kind) continue;
        if (this.findSameClaim(summary, kind, '*')) continue;
        const direct = r.evidence_kind === 'direct' || r.evidence_kind === 'manual' || r.evidence_kind === 'stated';
        const support = Math.max(1, Number(r.evidence_count ?? 1));
        const belief = this.insert({
          kind, dimension: null, level: null, statement: summary, detail: (r.detail as string | null) ?? null, context: '*',
          timescale: kind === 'episode' ? 'episodic' : 'stable', support: direct ? support + 1 : support, against: 0,
          supportSessions: Math.min(support, HELD_AT_SESSIONS), ownerStated: false,
          // The old extractor's "direct" was unreliable: only what it saw
          // twice starts as held; the first reflection pass promotes the rest.
          status: support >= HELD_AT_SESSIONS ? 'held' : 'candidate',
        }, Number(r.created_at ?? now));
        this.db.prepare('UPDATE beliefs SET last_supported_at = ?, created_at = ?, updated_at = ? WHERE id = ?').run(Number(r.last_seen_at ?? r.updated_at ?? now), Number(r.created_at ?? now), Number(r.updated_at ?? now), belief.id);
        this.addEvidence(belief.id, 'migration', { excerpt: `from memory ${String(r.id)}` }, support, Number(r.created_at ?? now));
        converted++;
      }
      this.setMeta('legacy_migrated', '1');
      // Ask for a reflection pass soon after boot so the migrated candidates get judged against real sessions.
      if (converted > 0) this.setMeta('reflection_force', '1');
    });
    logger.info({ quarantined, converted }, 'Legacy memories migrated to beliefs');
    return { quarantined, converted, skipped: false };
  }
}

/** True for beliefs that should change Mercury's behaviour (what the announcer reports). */
export function isBehavioral(b: Belief): boolean {
  return b.kind === 'trait' || b.kind === 'preference';
}

function toBelief(r: BeliefRow): Belief {
  return {
    id: r.id, ownerKey: r.owner_key, kind: r.kind, dimension: r.dimension, level: r.level, statement: r.statement, detail: r.detail,
    context: r.context, support: Number(r.support), against: Number(r.against), supportSessions: Number(r.support_sessions), timescale: r.timescale,
    status: r.status, ownerStated: !!r.owner_stated, validFrom: Number(r.valid_from), validTo: r.valid_to == null ? null : Number(r.valid_to),
    supersededBy: r.superseded_by, lastSupportedAt: Number(r.last_supported_at), lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), shareable: Number(r.shareable ?? 0) === 1,
  };
}

export function normalizeClaim(s: string): string {
  return s.toLowerCase().replace(/^(the )?(user|owner|salman)\s+/i, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter((t) => t.length > 2)); const B = new Set(b.split(' ').filter((t) => t.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0; for (const t of A) if (B.has(t)) shared++;
  return shared / Math.max(A.size, B.size);
}

const ASSISTANT_VOICE = /^(i |i'|i’|to |for the chat|\*\*memory|if you'd like|if you’d like|open |send |see |access |find |here's how|here’s how|\(no durable|you can |let me |sure[,!]|as an ai|i cannot|i can't)/i;

/** Rows the old extractor saved by mistake: Mercury's own replies and the non-JSON fallback's prose lines. */
export function isLegacyJunk(r: Record<string, unknown>): boolean {
  const summary = String(r.summary ?? '').trim();
  if (summary.length < 12) return true;
  if (ASSISTANT_VOICE.test(summary)) return true;
  if (/^[-*#`>|{}[\]"]/.test(summary)) return true;
  if (/\bI'm (Claude|an AI)|as an AI\b|my actual capabilities|my limitations/i.test(summary)) return true;
  // Claims whose subject is the assistant, not the owner, and throwaway test identities.
  if (/^(the )?(assistant|agent|mercury)\b.*\b(identifies|serving|serves|is an ai|can(not)?|will)\b/i.test(summary)) return true;
  if (/\b(assistant|mercury)'s creators?\b|owner and creator of the assistant/i.test(summary)) return true;
  if (/\bmercury-[a-z0-9]{6,}@/i.test(summary)) return true;
  if (/\b(password|passwd|api[ _-]?key|secret|token|otp)\b\s*[:=]?\s*\S/i.test(summary)) return true;
  const fallbackShape = r.type === 'preference' && r.evidence_kind === 'inferred' && Number(r.confidence) === 0.75 && String(r.categories ?? '') === '["general"]';
  if (fallbackShape && !/^(user|owner|the user|prefers|likes|dislikes|wants|salman)/i.test(summary)) return true;
  return false;
}

function legacyKind(type: string): BeliefKind | null {
  switch (type) {
    case 'identity': case 'decision': case 'habit': case 'fact': return 'fact';
    case 'preference': case 'constraint': return 'preference';
    case 'goal': return 'goal';
    case 'project': return 'project';
    case 'relationship': return 'relationship';
    case 'episode': return 'episode';
    default: return null;
  }
}
