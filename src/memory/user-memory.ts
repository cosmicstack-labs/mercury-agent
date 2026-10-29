import type { MercuryConfig } from '../utils/config.js';
import { getMemoryDir } from '../utils/config.js';
import { SecondBrainDB, type MemoryRow, type PersonListRow, type PersonGraph, type PersonKind } from './second-brain-db.js';
import { BeliefStore, type Belief, type BeliefKind } from './beliefs.js';
import { looksLikeSecret } from '../learning/text.js';
import { join } from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { buildKnowledgeMap, themeMemory, type KnowledgeMap, type ThemeMemory } from './knowledge-map.js';
import { capKnown, standingOf, type PersonStanding, type PersonTier } from './person-standing.js';
import { extractAliases, extractOwnerRelations, extractPersonLinks, isOwnerName, ownerNameSet } from './person-extract.js';

export type UserMemoryType =
  | 'identity'
  | 'preference'
  | 'goal'
  | 'project'
  | 'habit'
  | 'decision'
  | 'constraint'
  | 'relationship'
  | 'episode'
  | 'reflection';

export interface UserMemoryRecord {
  id: string;
  type: UserMemoryType;
  categories: string[];
  shareable: boolean;
  summary: string;
  detail?: string | null;
  scope: 'durable' | 'active' | 'subconscious';
  evidenceKind: 'direct' | 'inferred' | 'manual' | 'system';
  source: 'conversation' | 'system';
  confidence: number;
  importance: number;
  durability: number;
  evidenceCount: number;
  provenance?: string | null;
  dismissed: boolean;
  supersededBy?: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  lastUsedAt?: number | null;
  lastUsedQuery?: string | null;
}

export interface UserMemoryCandidate {
  type: UserMemoryType;
  summary: string;
  detail?: string;
  categories?: string[];
  shareable?: boolean;
  evidenceKind?: 'direct' | 'inferred';
  confidence: number;
  importance: number;
  durability: number;
}

export interface UserMemorySummary {
  total: number;
  subconsciousTotal: number;
  byType: Partial<Record<UserMemoryType, number>>;
  learningPaused: boolean;
  profileSummary?: string;
  activeSummary?: string;
}

export interface RetrievedUserMemory {
  records: UserMemoryRecord[];
  context: string;
}

export interface UserPersonRecord {
  id: string;
  name: string;
  canonicalName: string;
  relationshipToUser: string | null;
  description: string | null;
  confidence: number;
  memoryCount: number;
  /** 'person' | 'pet' | 'unverified'. */
  kind: string;
  /** 'owner' | 'model' | 'model-rejected' | null. */
  verifiedBy: string | null;
  /** Contact card: phone, email, birthday, location, company, notes, links. */
  meta: Record<string, unknown>;
  ownerEdited: boolean;
  /** How sure Mercury is that this is someone in your life, and why (person-standing.ts). */
  standing?: PersonStanding;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

// 8: stricter name rules, owner overrides, model checks for new names, beliefs indexed.
// 10: owner is never a person, real relationship phrasing, aliases merged, person-to-person links, standing.
const PERSON_INDEX_VERSION = '10';

export type KnowledgeMapResult = KnowledgeMap & {
  notes: Array<{ id: string; text: string; kind: string; at: number; confidence: number; archived: boolean }>;
};

export class UserMemoryStore {
  private db: SecondBrainDB;
  private userKey: string;
  private consolidateThrottleMs: number;
  private lastConsolidateAt: number = 0;
  /** When true, new memories are marked shareable for cloud fetch. */
  private shareLearning: boolean;
  /** What Mercury believes about this owner, with evidence (ADR-026). Shares the database. */
  readonly beliefs: BeliefStore;

  /** The owner's own names: never a person, always "you". */
  private ownerNames: Set<string>;
  /** Last knowledge map per mode, rebuilt only when the brain changed. */
  private mapCache = new Map<string, { key: string; value: KnowledgeMapResult }>();

  constructor(config: MercuryConfig, userKey: string = 'user:owner', dbPath?: string) {
    this.userKey = userKey;
    this.ownerNames = ownerNameSet(config.identity?.owner);
    this.consolidateThrottleMs = 5 * 60 * 1000;
    this.shareLearning = config.memory.collaborativeKnowledge?.shareLearning ?? false;
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'second-brain', 'second-brain.db');
    this.db = new SecondBrainDB(resolvedDbPath);
    this.db.init();
    this.beliefs = new BeliefStore(this.db.connection, userKey);
    this.beliefs.init();
    try {
      // The one-time move into beliefs (ADR-026) happens on the first boot
      // after an upgrade. A copy of the database goes next to it first, so an
      // existing owner can always get their old Second Brain back.
      if (!this.beliefs.migrationDone() && this.beliefs.legacyRowCount() > 0) backupDatabase(resolvedDbPath);
      const migrated = this.beliefs.migrateLegacyMemories();
      if (!migrated.skipped) logger.info(migrated, 'Second Brain: legacy memories migrated into beliefs');
    } catch (err) {
      logger.warn({ err }, 'Second Brain: belief migration failed (continuing with legacy memories)');
    }
  }

  /** Toggle whether new memories are marked shareable. */
  setShareLearning(enabled: boolean): void {
    this.shareLearning = enabled;
  }

  isShareLearning(): boolean {
    return this.shareLearning;
  }

  /**
   * Everything below reads and writes the belief store (ADR-026): one source
   * of truth. The legacy `memories` table is a read-only archive kept for the
   * quarantine queue and the persons graph; nothing new is written to it.
   */
  getSummary(): UserMemorySummary {
    const byKind = this.beliefs.countsByKind();
    const byType: Partial<Record<UserMemoryType, number>> = {};
    for (const [kind, n] of Object.entries(byKind)) {
      const t = kindToType(kind as BeliefKind);
      byType[t] = (byType[t] ?? 0) + n;
    }
    const counts = this.beliefs.counts();
    const brief = this.readBrief();
    return {
      total: counts.candidate + counts.held + counts.confirmed + counts.contested,
      subconsciousTotal: counts.retired,
      byType,
      learningPaused: this.isLearningPaused(),
      profileSummary: brief.about || undefined,
      activeSummary: brief.howToWork || undefined,
    };
  }

  /** The "About the owner" brief the reflection pass wrote (ADR-026). */
  getProfile(): string {
    return this.readBrief().about;
  }

  /** The "How to work with the owner" brief the reflection pass wrote. */
  getActiveSummary(): string {
    return this.readBrief().howToWork;
  }

  getRecent(limit: number = 10): UserMemoryRecord[] {
    return this.beliefs.recent(limit).map((b) => this.toBeliefRecord(b));
  }

  /**
   * Incremental fetch — shareable beliefs newer than the cursor. Used by the
   * cloud `memory.fetch` WS handler. Ordered by `updatedAt` ascending so the
   * caller can advance its watermark to the max.
   */
  getShareableSince(since: number, limit: number = 500): UserMemoryRecord[] {
    return this.beliefs.shareableSince(since, limit).map((b) => this.toBeliefRecord(b));
  }

  countShareable(): number {
    return this.beliefs.countShareable();
  }

  getShareable(limit: number = 50): UserMemoryRecord[] {
    return this.beliefs.shareable(limit).map((b) => this.toBeliefRecord(b));
  }

  setShareable(id: string, shareable: boolean): void {
    if (!this.beliefs.setShareable(id, shareable)) this.db.setShareable(id, shareable);
  }

  search(query: string, limit: number = 10): UserMemoryRecord[] {
    return this.beliefs.search(query, limit).map((b) => this.toBeliefRecord(b));
  }

  /** Search including retired beliefs (the dashboard's "all" scope). */
  searchAll(query: string, limit: number = 20): UserMemoryRecord[] {
    return this.beliefs.search(query, limit, ['candidate', 'held', 'confirmed', 'contested', 'retired']).map((b) => this.toBeliefRecord(b));
  }

  getByType(type: UserMemoryType): UserMemoryRecord[] {
    const kinds = typeToKinds(type);
    if (kinds.length === 0) return [];
    return this.beliefs.list({ kinds, limit: 500 }).map((b) => this.toBeliefRecord(b));
  }

  /**
   * People, each with its standing. `tier` narrows to known / shadow /
   * faint; omitted, everyone is returned (strongest first).
   */
  listPersons(query?: string, limit: number = 100, tier?: PersonTier): UserPersonRecord[] {
    this.indexNewBeliefs();
    const standings = this.standings();
    const rows = this.db.listPersons(this.userKey, query, 5000);
    return rows
      .map((row) => ({ ...this.toPersonRecord(row), standing: standings.get(row.id) }))
      .filter((p) => !tier || p.standing?.tier === tier)
      .sort((a, b) => (b.standing?.score ?? 0) - (a.standing?.score ?? 0) || b.memoryCount - a.memoryCount)
      .slice(0, Math.max(1, limit));
  }

  getPerson(personId: string): UserPersonRecord | null {
    this.ensurePersonsBackfilled();
    const row = this.db.getPersonWithCount(this.userKey, personId);
    if (!row) return null;
    return { ...this.toPersonRecord(row), standing: this.standings().get(personId) };
  }

  /** Standing for every person, with the known-people cap applied. */
  standings(): Map<string, PersonStanding> {
    const people = this.db.personEvidence(this.userKey).map((e) => ({
      id: e.id,
      ownerEdited: e.owner_edited === 1,
      standing: standingOf({
        mentions: e.mentions, socialMentions: e.social, distinctDays: e.days, relationship: e.relationship,
        personLinks: e.plinks, kind: e.kind, verifiedBy: e.verified_by, ownerEdited: e.owner_edited === 1,
      }),
    }));
    capKnown(people);
    return new Map(people.map((p) => [p.id, p.standing]));
  }

  /** The one-to-one relation holder (spouse, mother…) other than `exceptId`, for conflicts on edit. */
  exclusiveHolder(group: string, exceptId: string): UserPersonRecord | null {
    const row = this.db.exclusiveHolder(this.userKey, group, exceptId);
    return row ? this.getPerson(row.id) : null;
  }

  releaseExclusiveRelationship(group: string, exceptId: string): void {
    this.db.releaseExclusiveRelationship(this.userKey, group, exceptId);
  }

  // ── Owner curation of people (stable ids; rebuilds respect every decision) ──

  updatePerson(personId: string, fields: { displayName?: string; relationship?: string | null; description?: string | null; kind?: PersonKind; meta?: Record<string, unknown> }): UserPersonRecord | null {
    if (!this.db.updatePerson(this.userKey, personId, fields)) return null;
    return this.getPerson(personId);
  }

  markNotPerson(personId: string): boolean {
    return this.db.markNotPerson(this.userKey, personId);
  }

  mergePersons(fromId: string, intoId: string): boolean {
    return this.db.mergePersons(this.userKey, fromId, intoId);
  }

  /**
   * The graph: known people (and shadows when asked), the memories, and the
   * real links between them. Each person carries its tier and score.
   */
  personGraph(maxMemories: number, opts: { shadows?: boolean } = {}): Omit<PersonGraph, 'persons'> & { persons: Array<PersonGraph['persons'][number] & { tier: PersonTier; score: number }> } {
    this.indexNewBeliefs();
    const g = this.db.personGraph(this.userKey, maxMemories);
    const standings = this.standings();
    const persons = g.persons
      .map((p) => ({ ...p, tier: standings.get(p.id)?.tier ?? 'faint' as PersonTier, score: standings.get(p.id)?.score ?? 0 }))
      .filter((p) => p.tier === 'known' || (opts.shadows && p.tier === 'shadow'));
    const ids = new Set(persons.map((p) => p.id));
    return {
      persons,
      memories: g.memories,
      memoryPersons: g.memoryPersons.filter((l) => ids.has(l.personId)),
      relationships: g.relationships.filter((r) => ids.has(r.source) && ids.has(r.target)),
    };
  }

  pendingPersonChecks(limit: number) {
    this.indexNewBeliefs();
    return this.db.pendingPersonChecks(this.userKey, limit);
  }

  queueExistingPersonChecks(): number {
    this.indexNewBeliefs();
    return this.db.queueExistingPersonChecks(this.userKey);
  }

  countPersonChecks(): number {
    this.indexNewBeliefs();
    return this.db.countPersonChecks(this.userKey);
  }

  applyPersonCheck(personId: string, verdict: 'person' | 'pet' | 'not_person' | 'unsure'): void {
    this.db.applyPersonCheck(this.userKey, personId, verdict);
  }

  /** Everything about a person, live beliefs first then the legacy archive, one page at a time. No upper bound. */
  getPersonMemories(personId: string, limit: number = 50, offset = 0): UserMemoryRecord[] {
    return this.personMemoryPage(personId, limit, offset).records;
  }

  personMemoryPage(personId: string, limit: number = 50, offset = 0): { records: UserMemoryRecord[]; total: number } {
    this.indexNewBeliefs();
    const counts = this.db.countPersonMemories(this.userKey, personId);
    const take = Math.max(1, limit);
    const from = Math.max(0, offset);
    const live = from < counts.beliefs
      ? this.db.getBeliefIdsForPerson(personId, take, from)
        .map((id) => this.beliefs.get(id))
        .filter((b): b is NonNullable<typeof b> => Boolean(b))
        .map((b) => this.toBeliefRecord(b))
      : [];
    const rest = take - live.length;
    const legacy = rest > 0
      ? this.db.getMemoriesForPerson(this.userKey, personId, rest, Math.max(0, from - counts.beliefs)).map(row => this.toRecord(row))
      : [];
    return { records: [...live, ...legacy], total: counts.beliefs + counts.memories };
  }


  /** True while persons are rebuilt from old memories: those never queue model checks. */
  private rebuilding = false;

  rebuildPersonsFromMemory(): number {
    this.db.clearUserPersonGraph(this.userKey);
    const rows = this.db.getRelationshipMemoryRows(this.userKey);
    this.db.clearAllBeliefPersons(this.userKey);
    this.rebuilding = true;
    try {
      for (const row of rows) {
        this.indexPersonsForMemoryRow(row);
      }
      // The live brain: every current belief, as of now.
      const all = this.db.beliefsSince(this.userKey, 0, 100_000);
      for (const b of all) this.indexPersonsForBelief(b);
      const last = all[all.length - 1];
      this.db.setMeta(`${this.userKey}:persons_belief_cursor`, last ? `${last.created_at}:${last.seq}` : String(Date.now()));
    } finally {
      this.rebuilding = false;
    }
    this.db.deleteOrphanPersons(this.userKey);
    this.db.setMeta(`${this.userKey}:persons_backfilled`, '1');
    this.db.setMeta(`${this.userKey}:persons_backfilled_version`, PERSON_INDEX_VERSION);
    return rows.length;
  }

  /**
   * Beliefs relevant to a message, as a context block. The agent's own turn
   * path injects beliefs itself; this serves the bots and anything else that
   * wants one call.
   */
  retrieveRelevant(
    query: string,
    options?: { maxRecords?: number; maxChars?: number },
  ): RetrievedUserMemory {
    const maxRecords = options?.maxRecords ?? 5;
    const maxChars = options?.maxChars ?? 900;
    const relevant = this.beliefs.searchRelevant(query, maxRecords);
    if (relevant.length === 0) return { records: [], context: '' };

    const selected: typeof relevant = [];
    let currentLength = 0;
    for (const b of relevant) {
      const line = `- [${kindToType(b.kind)}] ${b.statement}`;
      if (selected.length > 0 && currentLength + line.length > maxChars) break;
      selected.push(b);
      currentLength += line.length + 1;
    }
    this.beliefs.markUsed(selected.map((b) => b.id));
    const context = ['Relevant user memory:', ...selected.map((b) => `- [${kindToType(b.kind)}] ${b.statement}`)].join('\n');
    return { records: selected.map((b) => this.toBeliefRecord(b)), context };
  }

  /**
   * Explicit saves (the save_memory tool, the dashboard's "add" form) become
   * beliefs: a direct save is the owner's word (confirmed, never decays); an
   * inferred one is a candidate that has to earn its place like any other.
   */
  remember(
    candidates: UserMemoryCandidate[],
    source: UserMemoryRecord['source'] = 'conversation',
  ): UserMemoryRecord[] {
    if (this.isLearningPaused()) return [];
    const remembered: UserMemoryRecord[] = [];
    for (const candidate of candidates) {
      const summary = candidate.summary?.trim() ?? '';
      if (summary.length < 4 || looksLikeSecret(summary) || (candidate.detail && looksLikeSecret(candidate.detail))) continue;
      const kind = typeToKinds(candidate.type)[0] ?? 'fact';
      const direct = candidate.evidenceKind !== 'inferred';
      const result = this.beliefs.apply({
        op: direct ? 'owner_stated' : 'create',
        kind,
        statement: summary,
        detail: candidate.detail?.trim() || undefined,
        context: '*',
        timescale: kind === 'situation' ? 'situational' : kind === 'episode' ? 'episodic' : 'stable',
        excerpt: source === 'system' ? 'saved by Mercury' : 'asked Mercury to remember this',
        evidenceKind: direct ? 'owner' : 'observed',
        weight: direct ? 2 : 1,
        shareable: candidate.shareable ?? this.shareLearning,
      });
      if (result) remembered.push(this.toBeliefRecord(result.belief));
    }
    return remembered;
  }

  setLearningPaused(paused: boolean): void {
    this.db.setMeta(`${this.userKey}:learning_paused`, paused ? '1' : '0');
  }

  isLearningPaused(): boolean {
    return this.db.getMeta(`${this.userKey}:learning_paused`) === '1';
  }

  /** "Clear all memories": beliefs, their evidence and the legacy archive, gone. */
  clear(): number {
    const beliefs = this.beliefs.clearAll();
    const legacy = this.db.clearByType(this.userKey);
    return beliefs + legacy;
  }

  /**
   * @deprecated The reflection pass (Agent.reflectNow) maintains the owner
   * brief now. Kept so older callers keep working; does nothing.
   */
  consolidate(): { profileUpdated: boolean; reflectionCount: number } {
    return { profileUpdated: false, reflectionCount: 0 };
  }

  softDeleteMemory(id: string): boolean {
    if (this.beliefs.forget(id)) return true;
    const row = this.db.getById(id);
    return row && row.user_key === this.userKey ? this.db.softDelete(id) : false;
  }

  updateMemory(id: string, updates: Record<string, any>): UserMemoryRecord | null {
    const belief = this.beliefs.get(id);
    if (belief) {
      const kind = typeof updates.type === 'string' ? typeToKinds(updates.type as UserMemoryType)[0] : undefined;
      const edited = this.beliefs.edit(id, {
        statement: typeof updates.summary === 'string' ? updates.summary : undefined,
        detail: updates.detail === undefined ? undefined : (updates.detail ?? null),
        kind,
      });
      if (edited && typeof updates.shareable === 'boolean') this.beliefs.setShareable(id, updates.shareable);
      const fresh = this.beliefs.get(id);
      return fresh ? this.toBeliefRecord(fresh) : null;
    }
    const existing = this.db.getById(id);
    if (!existing || existing.user_key !== this.userKey) return null;
    this.db.update({ id, ...updates, updated_at: Date.now() });
    const updated = this.db.getById(id);
    return updated ? this.toRecord(updated) : null;
  }

  /** The decay pass: beliefs that faded and were contradicted or went stale retire. */
  prune(): { movedToSubconscious: number; promoted: number; hardDeleted: number } {
    const retired = this.beliefs.decayPass();
    if (retired > 0) logger.debug({ retired, userKey: this.userKey }, 'Retired faded beliefs');
    return { movedToSubconscious: retired, promoted: 0, hardDeleted: 0 };
  }

  /** Retired beliefs: still searchable, no longer shown to the model. */
  getSubconscious(limit: number = 10): UserMemoryRecord[] {
    return this.beliefs.list({ statuses: ['retired'], limit }).map((b) => this.toBeliefRecord(b));
  }

  /**
   * Everything known, as a mind map (knowledge-map.ts): themes, sub-themes,
   * notes and sparse "related" links. Local and free (no model calls);
   * cached until a belief or archive row changes; theme ids carry over from
   * the last build so colours and places stay put.
   */
  knowledgeMap(opts: { archive?: boolean } = {}): KnowledgeMapResult {
    const archive = !!opts.archive;
    const mode = archive ? 'archive' : 'live';
    const key = this.db.knowledgeSignature(this.userKey, this.userKey, archive);
    const hit = this.mapCache.get(mode);
    if (hit && hit.key === key) return hit.value;
    const now = Date.now();
    const notes: KnowledgeMapResult['notes'] = this.beliefs.list({ limit: 100_000 }).map((b) => ({
      id: b.id, text: b.statement, kind: b.kind, at: b.updatedAt, confidence: Number(this.beliefs.confidence(b, now).toFixed(3)), archived: false,
    }));
    if (archive) for (const r of this.db.archiveNotes(this.userKey)) notes.push({ ...r, archived: true });
    const metaKey = `knowledge_map_themes_v1_${mode}`;
    let previous: ThemeMemory = {};
    try { previous = JSON.parse(this.db.getMeta(metaKey) ?? '{}') as ThemeMemory; } catch { /* rebuild fresh */ }
    const owner = [...this.ownerNames].filter((n) => n !== 'user' && n !== 'the user');
    const map = buildKnowledgeMap(notes.map((n) => ({ id: n.id, text: n.text, kind: n.kind, at: n.at, weight: n.archived ? 0.5 : 1 })), previous, { ownerNames: owner });
    try { this.db.setMeta(metaKey, JSON.stringify(themeMemory(map))); } catch { /* ids just won't carry over */ }
    const value = { ...map, notes };
    this.mapCache.set(mode, { key, value });
    return value;
  }

  getById(id: string): UserMemoryRecord | null {
    const belief = this.beliefs.get(id);
    if (belief) return this.toBeliefRecord(belief);
    const row = this.db.getById(id);
    return row && row.user_key === this.userKey ? this.toRecord(row) : null;
  }

  /** Legacy rows the belief migration quarantined (ADR-026 §3.7), for the dashboard's review queue. */
  listQuarantined(limit: number = 500): UserMemoryRecord[] {
    return this.db.listQuarantined(this.userKey, limit).map(row => this.toRecord(row));
  }

  /** Restoring a quarantined row turns it into a belief the owner vouched for; returns the belief's id. */
  restoreQuarantined(id: string): string | null {
    const row = this.db.getById(id);
    if (!row || row.user_key !== this.userKey || row.scope !== 'quarantine' || row.dismissed) return null;
    const kind = typeToKinds(row.type as UserMemoryType)[0] ?? 'fact';
    const result = this.beliefs.apply({
      op: 'owner_stated', kind, statement: row.summary, detail: row.detail ?? undefined, context: '*',
      timescale: kind === 'situation' ? 'situational' : kind === 'episode' ? 'episodic' : 'stable',
      excerpt: 'restored from quarantine by the owner', evidenceKind: 'owner', weight: 2,
    });
    if (!result) return null;
    this.db.update({ id, dismissed: 1, provenance: `migration:restored→${result.belief.id}`, updated_at: Date.now() });
    return result.belief.id;
  }

  close(): void {
    this.db.close();
  }

  private readBrief(): { about: string; howToWork: string } {
    try {
      const raw = this.beliefs.getMeta('brief');
      if (!raw) return { about: '', howToWork: '' };
      const parsed = JSON.parse(raw) as { about?: string; howToWork?: string };
      return { about: (parsed.about ?? '').trim(), howToWork: (parsed.howToWork ?? '').trim() };
    } catch {
      return { about: '', howToWork: '' };
    }
  }

  /** A belief in the record shape every existing reader (menus, dashboard, cloud sync) expects. */
  private toBeliefRecord(b: Belief): UserMemoryRecord {
    const confidence = this.beliefs.confidence(b);
    const scope: UserMemoryRecord['scope'] = b.status === 'held' || b.status === 'confirmed' ? 'durable'
      : b.status === 'retired' || b.status === 'forgotten' ? 'subconscious' : 'active';
    const categories = [b.kind, ...(b.dimension ? [b.dimension] : []), ...(b.context !== '*' ? [b.context] : [])];
    return {
      id: b.id,
      type: kindToType(b.kind),
      categories,
      shareable: b.shareable,
      summary: b.statement,
      detail: b.detail,
      scope,
      evidenceKind: b.ownerStated ? 'direct' : 'inferred',
      source: 'conversation',
      confidence,
      importance: b.status === 'confirmed' ? 0.9 : b.status === 'held' ? 0.75 : b.status === 'contested' ? 0.6 : 0.5,
      durability: b.timescale === 'stable' ? 0.9 : b.timescale === 'episodic' ? 0.5 : 0.2,
      evidenceCount: Math.max(1, Math.round(b.support)),
      provenance: `belief:${b.status}${b.level ? `:${b.level}` : ''}`,
      dismissed: b.status === 'forgotten',
      supersededBy: b.supersededBy,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      lastSeenAt: b.lastSupportedAt,
      lastUsedAt: b.lastUsedAt,
      lastUsedQuery: null,
    };
  }

  private ensurePersonsBackfilled(): void {
    const done = this.db.getMeta(`${this.userKey}:persons_backfilled`) === '1';
    const version = this.db.getMeta(`${this.userKey}:persons_backfilled_version`);
    if (done && version === PERSON_INDEX_VERSION) return;
    this.rebuildPersonsFromMemory();
  }

  private toPersonRecord(row: PersonListRow): UserPersonRecord {
    return {
      id: row.id,
      name: row.display_name,
      canonicalName: row.canonical_name,
      relationshipToUser: row.relationship_to_user,
      description: row.description,
      confidence: row.confidence,
      memoryCount: row.memory_count,
      kind: row.kind ?? 'unverified',
      verifiedBy: row.verified_by ?? null,
      meta: parseMeta(row.meta),
      ownerEdited: row.owner_edited === 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * People in beliefs created since the last pass. These are NEW mentions, so
   * new people they create are queued for a check. Cheap when nothing is new.
   */
  indexNewBeliefs(): number {
    this.ensurePersonsBackfilled();
    // Cursor "created_at:rowid"; a bare "created_at" covers that whole millisecond.
    const [at, seq] = (this.db.getMeta(`${this.userKey}:persons_belief_cursor`) ?? '0').split(':');
    const fresh = this.db.beliefsSince(this.userKey, Number(at) || 0, 200, seq === undefined ? Number.MAX_SAFE_INTEGER : Number(seq) || 0);
    for (const b of fresh) this.indexPersonsForBelief(b);
    if (fresh.length) { const last = fresh[fresh.length - 1]; this.db.setMeta(`${this.userKey}:persons_belief_cursor`, `${last.created_at}:${last.seq}`); }
    return fresh.length;
  }

  private indexPersonsForBelief(b: { id: string; statement: string; detail: string | null; kind: string; confidence: number }): void {
    const text = `${b.statement} ${b.detail ?? ''}`.trim();
    if (!text) return;
    this.db.clearBeliefPersons(b.id);
    const queueCheck = this.rebuilding ? null : { context: text };
    const seen = new Set<string>();
    const social = b.kind === 'relationship' || b.kind === 'episode';
    // "Zaid (Zayd)": one person with two spellings, merged before anyone is linked.
    for (const [name, alias] of extractAliases(text)) this.absorbAlias(name, alias);
    const link = (name: string, relation: string | null, role: string) => {
      if (isOwnerName(name, this.ownerNames)) return;
      const person = this.db.upsertPerson({ userKey: this.userKey, name, relationshipToUser: relation, confidence: b.confidence, queueCheck });
      if (!person || seen.has(person.id)) return;
      seen.add(person.id);
      this.db.addPersonAlias(person.id, name, 'memory');
      this.db.linkBeliefPerson(b.id, person.id, role, b.confidence);
    };
    for (const m of extractOwnerRelations(text, this.ownerNames, (seg) => extractHumanNames(seg, true), { social })) link(m.name, m.relation, 'relationship');
    // New people come only from beliefs about people; other beliefs link to people already known.
    if (b.kind === 'relationship' || b.kind === 'episode') {
      // A belief about a relationship is about people: a name may open the sentence there
      // ("Shehzen visited"); new names from it are checked by the model anyway.
      for (const name of extractHumanNames(text, b.kind === 'relationship')) link(name, b.kind === 'relationship' ? 'known' : null, 'mention');
    }
    // Known people mentioned by name or alias.
    for (const person of this.db.listPersons(this.userKey, '', 5000)) {
      if (seen.has(person.id)) continue;
      if (mentionsPerson(text, person.display_name) || mentionsPerson(text, person.canonical_name)) {
        seen.add(person.id);
        this.db.linkBeliefPerson(b.id, person.id, 'interaction', b.confidence);
      }
    }
    // Between people: "Zaid dislikes Shehzen", "Ali is Sara's brother".
    for (const l of extractPersonLinks(text, this.ownerNames, isLikelyHumanName)) {
      const a = this.db.resolvePersonId(this.userKey, l.a);
      const c = this.db.resolvePersonId(this.userKey, l.b);
      if (a && c && a !== c) this.db.upsertPersonRelationship({ userKey: this.userKey, sourcePersonId: a, targetPersonId: c, relationType: l.type, strength: b.confidence, evidenceMemoryId: null });
      // (evidence_memory_id references the legacy archive; beliefs are cleared by a full rebuild instead.)
    }
  }

  /**
   * Two spellings of one person ("Zaid (Zayd)"). The alias is recorded so
   * future mentions resolve; if both already exist as separate people, the
   * one with less evidence folds into the other. Not an owner decision: the
   * owner can still split or rename.
   */
  private absorbAlias(name: string, alias: string): void {
    if (isOwnerName(name, this.ownerNames) || isOwnerName(alias, this.ownerNames)) return;
    if (!isLikelyHumanName(name) || !isLikelyHumanName(alias)) return;
    const a = this.db.resolvePersonId(this.userKey, name);
    const b = this.db.resolvePersonId(this.userKey, alias);
    if (a && b && a !== b) {
      const rowA = this.db.getPersonById(a);
      const rowB = this.db.getPersonById(b);
      if (!rowA || !rowB || (rowA.owner_edited === 1 && rowB.owner_edited === 1)) return;
      const ev = new Map(this.db.personEvidence(this.userKey).map((e) => [e.id, e.mentions]));
      // Keep the owner-edited one, else the one with more evidence.
      const keepA = rowA.owner_edited === 1 || (rowB.owner_edited !== 1 && (ev.get(a) ?? 0) >= (ev.get(b) ?? 0));
      this.db.mergePersons(this.userKey, keepA ? b : a, keepA ? a : b, { byOwner: false });
      return;
    }
    if (a && !b) this.db.addPersonAlias(a, alias, 'memory');
    else if (b && !a) this.db.addPersonAlias(b, name, 'memory');
  }

  private indexPersonsForMemory(memory: UserMemoryRecord): void {
    const row = this.db.getById(memory.id);
    if (row) this.indexPersonsForMemoryRow(row);
  }

  private indexPersonsForMemoryRow(memory: MemoryRow): void {
    if (memory.dismissed === 1) return;
    if (!['relationship', 'episode', 'identity', 'project'].includes(memory.type)) return;

    const text = `${memory.summary} ${memory.detail ?? ''}`.trim();
    if (!text) return;

    this.db.clearMemoryPersons(memory.id);
    this.db.clearRelationshipsByMemory(memory.id);

    if (memory.type === 'relationship') {
      const relationMentions = extractOwnerRelations(text, this.ownerNames, (seg) => extractHumanNames(seg, true), { social: true });
      if (relationMentions.length > 0) {
        for (const mention of relationMentions) {
          if (isOwnerName(mention.name, this.ownerNames)) continue;
          const person = this.db.upsertPerson({
            userKey: this.userKey,
            name: mention.name,
            relationshipToUser: mention.relation,
            confidence: memory.confidence,
            queueCheck: this.rebuilding ? null : { context: text },
          });
          if (!person) continue;
          this.db.addPersonAlias(person.id, mention.name, 'memory');
          this.db.linkMemoryPerson(memory.id, person.id, 'relationship', memory.confidence);
        }
      } else {
        // Fallback: extract any capitalized names from relationship memories
        const names = extractHumanNames(text);
        for (const name of names) {
          if (isOwnerName(name, this.ownerNames)) continue;
          const person = this.db.upsertPerson({
            userKey: this.userKey,
            name,
            relationshipToUser: 'known',
            confidence: memory.confidence,
            queueCheck: this.rebuilding ? null : { context: text },
          });
          if (!person) continue;
          this.db.addPersonAlias(person.id, name, 'memory');
          this.db.linkMemoryPerson(memory.id, person.id, 'relationship', memory.confidence);
        }
      }
      return;
    }

    // For identity/project/episode: extract names and create/link persons
    const names = extractHumanNames(text);
    for (const name of names) {
      if (isOwnerName(name, this.ownerNames)) continue;
      const person = this.db.upsertPerson({
        userKey: this.userKey,
        name,
        relationshipToUser: 'known',
        confidence: memory.confidence,
        queueCheck: this.rebuilding ? null : { context: text },
      });
      if (!person) continue;
      this.db.addPersonAlias(person.id, name, 'memory');
      this.db.linkMemoryPerson(memory.id, person.id, 'mention', memory.confidence);
    }

    // Also link to already-known persons by alias/name match
    const knownPersons = this.db.listPersons(this.userKey, '', 300);
    for (const person of knownPersons) {
      if (mentionsPerson(text, person.display_name) || mentionsPerson(text, person.canonical_name)) {
        this.db.linkMemoryPerson(memory.id, person.id, 'interaction', memory.confidence);
      }
    }
  }

  private toRecord(row: MemoryRow): UserMemoryRecord {
    let categories: string[] = [];
    try {
      const parsed = JSON.parse(row.categories ?? '[]');
      if (Array.isArray(parsed)) categories = parsed as string[];
    } catch { /* malformed */ }
    return {
      id: row.id,
      type: row.type as UserMemoryType,
      categories,
      shareable: row.shareable === 1,
      summary: row.summary,
      detail: row.detail,
      scope: row.scope as 'durable' | 'active' | 'subconscious',
      evidenceKind: row.evidence_kind as UserMemoryRecord['evidenceKind'],
      source: row.source as UserMemoryRecord['source'],
      confidence: row.confidence,
      importance: row.importance,
      durability: row.durability,
      evidenceCount: row.evidence_count,
      provenance: row.provenance,
      dismissed: row.dismissed === 1,
      supersededBy: row.superseded_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at,
      lastUsedAt: row.last_used_at,
      lastUsedQuery: row.last_used_query,
    };
  }
}


const NON_PERSON_TERMS = new Set([
  'User', 'Users',
  'I', 'The', 'This', 'That', 'Today', 'Tomorrow', 'Yesterday', 'Monday', 'Tuesday',
  'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February',
  'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December', 'Mercury', 'Openai', 'Anthropic', 'Kashmir', 'Article', 'Covid',
]);

/**
 * Words that are never (part of) a person's name: pronouns, determiners,
 * function words, common verbs and nouns, and software/product vocabulary.
 * Any token from this set rejects the whole candidate ("Brain Graph",
 * "System Fixes User", "Married", "During", "She").
 */
const NON_NAME_TOKENS = new Set([
  // pronouns, determiners, function words
  'user', 'users', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'we', 'us', 'our', 'they', 'them', 'their',
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'and', 'or', 'but', 'if', 'then', 'so', 'because', 'while', 'during', 'after', 'before', 'since', 'until', 'about', 'with', 'without', 'from', 'into', 'onto', 'for', 'of', 'on', 'in', 'at', 'by', 'to', 'as', 'also', 'just', 'only', 'very', 'not', 'no', 'yes', 'all', 'any', 'some', 'each', 'every', 'both', 'more', 'most', 'other', 'another', 'such',
  // common verbs / states that start sentences
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must',
  // verbs and fillers that open a sentence in notes ("Recalled …", "Posted …")
  'despite', 'invited', 'recalled', 'makes', 'made', 'posted', 'stated', 'noted', 'corrected', 'studied', 'collaborates', 'operates', 'derived', 'asked', 'said', 'says', 'wants', 'prefers', 'uses', 'used', 'likes', 'loves', 'built', 'building', 'created', 'fixed', 'added', 'shared', 'sent', 'replied', 'reply', 'confirmed', 'decided', 'started', 'finished', 'moved', 'plans', 'planned', 'profile', 'founders', 'fleet', 'phase', 'multi', 'governance', 'cycle', 'crisis', 'sites', 'reels', 'traffic', 'spec', 'impact', 'home', 'path',
  'task', 'tasks', 'node', 'active', 'full', 'three', 'two', 'one', 'four', 'five', 'recent', 'card', 'cards', 'vulnerabilities', 'downloads', 'official', 'account', 'developing', 'email', 'jira', 'creating', 'combinator', 'console', 'status', 'ready', 'completed', 'application', 'current', 'multiple', 'part', 'colab', 'includes', 'fork', 'mentioned', 'manages', 'requested', 'form', 'context', 'assigned', 'temp', 'issue', 'issues', 'next', 'real', 'progress', 'write', 'main', 'sub', 'setting', 'successfully', 'maintainers', 'new', 'old', 'first', 'last', 'daily', 'weekly', 'india', 'pakistan', 'search', 'checker', 'oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'mercury', 'optimus',
  'married', 'working', 'works', 'worked', 'building', 'built', 'using', 'used', 'uses', 'wants', 'wanted', 'likes', 'liked', 'prefers', 'preferred', 'asked', 'asks', 'said', 'says', 'told', 'needs', 'needed', 'started', 'finished', 'created', 'updated', 'fixed', 'fixes', 'added', 'removed', 'please', 'thanks', 'thank',
  // roles and generic nouns
  'assistant', 'agent', 'agents', 'bot', 'bots', 'model', 'models', 'owner', 'admin', 'team', 'company', 'project', 'projects', 'product', 'products', 'customer', 'client', 'friend', 'friends', 'family', 'wife', 'husband', 'partner', 'mother', 'father', 'son', 'daughter', 'brother', 'sister',
  // software and product vocabulary
  'app', 'apps', 'web', 'website', 'site', 'page', 'interface', 'ui', 'ux', 'api', 'server', 'system', 'systems', 'graph', 'brain', 'memory', 'memories', 'animation', 'dashboard', 'desktop', 'mobile', 'code', 'repo', 'stack', 'cloud', 'plugin', 'plugins', 'skill', 'skills', 'chat', 'session', 'sessions', 'file', 'files', 'folder', 'data', 'database', 'feature', 'features', 'bug', 'bugs', 'fix', 'release', 'version', 'build', 'test', 'tests', 'error', 'errors', 'mode', 'settings', 'config', 'github', 'google', 'youtube', 'whatsapp', 'telegram', 'slack', 'discord', 'twitter', 'linkedin', 'battlefield', 'prime', 'architect',
]);

function extractHumanNames(segment: string, allowSentenceStart = false): string[] {
  const found = new Set<string>();
  const nameRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  // Words capitalised somewhere OTHER than the start of a sentence: a
  // sentence-initial "Task" or "Active" is just English, not a name.
  const midSentence = new Set<string>();
  const firstWords = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(segment)) !== null) {
    const before = segment.slice(0, match.index);
    const atStart = /(^|[.!?:;\n•\-–—([]\s*)$/.test(before);
    const first = match[1].split(' ')[0];
    if (atStart) firstWords.add(first);
    else midSentence.add(first);
  }
  nameRegex.lastIndex = 0;
  while ((match = nameRegex.exec(segment)) !== null) {
    const name = match[1].trim();
    if (!isLikelyHumanName(name)) continue;
    const before = segment.slice(0, match.index);
    const atStart = /(^|[.!?:;\n•\-–—([]\s*)$/.test(before);
    const single = !name.includes(' ');
    if (!allowSentenceStart && atStart && single && !midSentence.has(name)) continue;
    found.add(name);
  }
  return [...found.values()];
}

function isLikelyHumanName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 48) return false;
  if (NON_PERSON_TERMS.has(name)) return false;
  const parts = name.split(' ').filter(Boolean);
  if (parts.some((p) => NON_NAME_TOKENS.has(p.toLowerCase()))) return false;
  if (parts.length === 1 && parts[0].length < 3) return false;
  return parts.every(part => /^[A-Z][a-z]+$/.test(part));
}

function mentionsPerson(text: string, name: string): boolean {
  if (!name) return false;
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  if (!escaped) return false;
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  return regex.test(text);
}

/** `second-brain.db` → `second-brain.pre-owner-model.db`, once; never overwrites an earlier copy. */
function backupDatabase(dbPath: string): void {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return;
  const backup = dbPath.replace(/\.db$/, '') + '.pre-owner-model.db';
  if (existsSync(backup)) return;
  try {
    copyFileSync(dbPath, backup);
    logger.info({ backup }, 'Second Brain: backed up before the Owner Model migration');
  } catch (err) {
    logger.warn({ err, backup }, 'Second Brain: backup before migration failed (continuing)');
  }
}

/** Memory types the old API speaks ↔ belief kinds (ADR-026). */
function kindToType(kind: BeliefKind): UserMemoryType {
  switch (kind) {
    case 'fact': return 'identity';
    case 'trait': return 'habit';
    case 'situation': return 'episode';
    default: return kind;
  }
}

function typeToKinds(type: UserMemoryType): BeliefKind[] {
  switch (type) {
    case 'identity': return ['fact'];
    case 'habit': return ['trait'];
    case 'constraint': return ['preference'];
    case 'decision': return ['episode'];
    case 'episode': return ['episode', 'situation'];
    case 'reflection': return [];
    default: return [type];
  }
}

export { isLikelyHumanName };

function parseMeta(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
