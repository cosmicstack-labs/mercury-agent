import type { MercuryConfig } from '../utils/config.js';
import { getMemoryDir } from '../utils/config.js';
import { SecondBrainDB, type MemoryRow, type PersonListRow } from './second-brain-db.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

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
  summary: string;
  detail?: string | null;
  scope: 'durable' | 'active';
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
  evidenceKind?: 'direct' | 'inferred';
  confidence: number;
  importance: number;
  durability: number;
}

export interface UserMemorySummary {
  total: number;
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
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

const MIN_CONFIDENCE = 0.55;
const PERSON_INDEX_VERSION = '3';

export class UserMemoryStore {
  private db: SecondBrainDB;
  private maxRecords: number;
  private userKey: string;
  private consolidateThrottleMs: number;
  private lastConsolidateAt: number = 0;

  constructor(config: MercuryConfig, userKey: string = 'user:owner', dbPath?: string) {
    this.userKey = userKey;
    this.maxRecords = config.memory.secondBrain?.maxRecords ?? 50;
    this.consolidateThrottleMs = 5 * 60 * 1000;
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'second-brain', 'second-brain.db');
    this.db = new SecondBrainDB(resolvedDbPath);
    this.db.init();
  }

  getSummary(): UserMemorySummary {
    const byType = this.db.countByType(this.userKey) as Partial<Record<UserMemoryType, number>>;
    return {
      total: this.db.totalActive(this.userKey),
      byType,
      learningPaused: this.isLearningPaused(),
      profileSummary: this.db.getMeta(`${this.userKey}:profile_summary`) ?? undefined,
      activeSummary: this.db.getMeta(`${this.userKey}:active_summary`) ?? undefined,
    };
  }

  getProfile(): string {
    return this.db.getMeta(`${this.userKey}:profile_summary`) || '';
  }

  getActiveSummary(): string {
    return this.db.getMeta(`${this.userKey}:active_summary`) || '';
  }

  getRecent(limit: number = 10): UserMemoryRecord[] {
    const stmt = this.db.getActive(this.userKey).slice(0, limit);
    return stmt.map(row => this.toRecord(row));
  }

  search(query: string, limit: number = 10): UserMemoryRecord[] {
    const rows = this.db.searchFTS(this.userKey, query, limit);
    return rows.map(row => this.toRecord(row));
  }

  getByType(type: UserMemoryType): UserMemoryRecord[] {
    const rows = this.db.getByType(this.userKey, type);
    return rows.map(row => this.toRecord(row));
  }

  listPersons(query?: string, limit: number = 100): UserPersonRecord[] {
    this.ensurePersonsBackfilled();
    const rows = this.db.listPersons(this.userKey, query, limit);
    return rows.map(row => this.toPersonRecord(row));
  }

  getPerson(personId: string): UserPersonRecord | null {
    this.ensurePersonsBackfilled();
    const row = this.db.getPersonWithCount(this.userKey, personId);
    if (!row) return null;
    return this.toPersonRecord(row);
  }

  getPersonMemories(personId: string, limit: number = 50): UserMemoryRecord[] {
    this.ensurePersonsBackfilled();
    const rows = this.db.getMemoriesForPerson(this.userKey, personId, limit);
    return rows.map(row => this.toRecord(row));
  }

  rebuildPersonsFromMemory(): number {
    this.db.clearUserPersonGraph(this.userKey);
    const rows = this.db.getRelationshipMemoryRows(this.userKey);
    for (const row of rows) {
      this.indexPersonsForMemoryRow(row);
    }
    this.db.deleteOrphanPersons(this.userKey);
    this.db.setMeta(`${this.userKey}:persons_backfilled`, '1');
    this.db.setMeta(`${this.userKey}:persons_backfilled_version`, PERSON_INDEX_VERSION);
    return rows.length;
  }

  retrieveRelevant(
    query: string,
    options?: { maxRecords?: number; maxChars?: number },
  ): RetrievedUserMemory {
    const maxRecords = options?.maxRecords ?? 5;
    const maxChars = options?.maxChars ?? 900;

    const ftsResults = this.db.searchRelevant(this.userKey, query, Math.max(maxRecords * 2, 10));
    const ranked = this.scoreAndRank(ftsResults, query);

    const selected: MemoryRow[] = [];
    let currentLength = 0;
    for (const row of ranked) {
      const line = `- [${row.type}] ${row.summary}`;
      if (selected.length >= maxRecords) break;
      if (selected.length > 0 && currentLength + line.length > maxChars) break;
      selected.push(row);
      currentLength += line.length + 1;
    }

    if (selected.length === 0) {
      const profile = this.getProfile().trim();
      if (!profile) {
        return { records: [], context: '' };
      }
      return {
        records: [],
        context: [
          this.getActiveSummary() ? `User active state:\n- ${this.getActiveSummary()}` : '',
          `User profile summary:\n- ${profile}`,
        ].filter(Boolean).join('\n\n'),
      };
    }

    const contextLines: string[] = [];
    const activeSummary = this.getActiveSummary();
    if (activeSummary) {
      contextLines.push('User active state:');
      contextLines.push(`- ${activeSummary}`);
      contextLines.push('');
    }
    const profileSummary = this.getProfile();
    if (profileSummary) {
      contextLines.push('User profile summary:');
      contextLines.push(`- ${profileSummary}`);
      contextLines.push('');
    }
    contextLines.push('Relevant user memory:');
    contextLines.push(...selected.map(row => `- [${row.type}] ${row.summary}`));

    this.markUsed(selected.map(r => r.id), query);
    return { records: selected.map(r => this.toRecord(r)), context: contextLines.join('\n') };
  }

  remember(
    candidates: UserMemoryCandidate[],
    source: UserMemoryRecord['source'] = 'conversation',
  ): UserMemoryRecord[] {
    if (this.isLearningPaused()) return [];

    const remembered: UserMemoryRecord[] = [];

    for (const candidate of candidates) {
      if (!shouldStoreCandidate(candidate)) continue;

      const terms = normalize(candidate.summary).split(/\s+/).filter(t => t.length > 2);

      const mergeTarget = this.db.findMergeCandidate(this.userKey, candidate.type, terms);
      if (mergeTarget && overlapScore(normalize(mergeTarget.summary), normalize(candidate.summary)) >= 0.74) {
        const merged = this.mergeRecord(mergeTarget, candidate);
        if (merged) {
          remembered.push(merged);
          this.indexPersonsForMemory(merged);
        }
        continue;
      }

      const conflictTarget = this.db.findConflictCandidate(this.userKey, candidate.type, terms);
      if (conflictTarget) {
        const conflictWinner = this.resolveConflict(conflictTarget, candidate);
        if (conflictWinner === 'existing') continue;
      }

      const record = this.insertRecord(candidate, source);
      if (record) {
        remembered.push(record);
        this.indexPersonsForMemory(record);
      }
    }

    this.enforceMaxRecords();

    return remembered;
  }

  setLearningPaused(paused: boolean): void {
    this.db.setMeta(`${this.userKey}:learning_paused`, paused ? '1' : '0');
  }

  isLearningPaused(): boolean {
    return this.db.getMeta(`${this.userKey}:learning_paused`) === '1';
  }

  clear(): number {
    return this.db.clearByType(this.userKey);
  }

  consolidate(): { profileUpdated: boolean; reflectionCount: number } {
    const now = Date.now();
    if (now - this.lastConsolidateAt < this.consolidateThrottleMs && this.lastConsolidateAt > 0) {
      return { profileUpdated: false, reflectionCount: 0 };
    }
    this.lastConsolidateAt = now;

    const allActive = this.db.getActive(this.userKey);
    const nonReflection = allActive.filter(r => r.type !== 'reflection');

    const profileSummary = buildProfileSummary(nonReflection);
    const activeSummary = buildActiveSummary(nonReflection);

    const oldProfile = this.db.getMeta(`${this.userKey}:profile_summary`) || '';
    const oldActive = this.db.getMeta(`${this.userKey}:active_summary`) || '';
    const profileUpdated = profileSummary !== oldProfile || activeSummary !== oldActive;

    this.db.setMeta(`${this.userKey}:profile_summary`, profileSummary);
    this.db.setMeta(`${this.userKey}:active_summary`, activeSummary);

    const reflections = buildReflectionCandidates(nonReflection);
    let reflectionCount = 0;
    for (const reflection of reflections) {
      const sameType = this.db.getByType(this.userKey, 'reflection');
      const existing = findMergeTarget(sameType, reflection);
      if (existing) {
        this.db.update({
          id: existing.id,
          summary: reflection.summary,
          detail: reflection.detail || existing.detail,
          confidence: clamp(Math.max(existing.confidence, reflection.confidence), 0, 1),
          importance: clamp(Math.max(existing.importance, reflection.importance), 0, 1),
          durability: clamp(Math.max(existing.durability, reflection.durability), 0, 1),
          updated_at: Date.now(),
          last_seen_at: Date.now(),
        });
      } else {
        this.insertReflection(reflection);
      }
      reflectionCount += 1;
    }

    return { profileUpdated, reflectionCount };
  }

  softDeleteMemory(id: string): boolean {
    return this.db.softDelete(id);
  }

  updateMemory(id: string, updates: Record<string, any>): UserMemoryRecord | null {
    const existing = this.db.getById(id);
    if (!existing) return null;
    this.db.update({ id, ...updates, updated_at: Date.now() });
    const updated = this.db.getById(id);
    if (!updated) return null;
    const record = this.toRecord(updated);
    this.indexPersonsForMemory(record);
    return record;
  }

  prune(): { activePruned: number; durablePruned: number; promoted: number } {
    const promoted = this.db.promoteToDurable(this.userKey);
    const { activePruned, durablePruned } = this.db.pruneStale(this.userKey);
    const hardDeleted = this.db.hardDeleteDismissed(this.userKey);
    if (hardDeleted > 0) {
      logger.debug({ hardDeleted, userKey: this.userKey }, 'Hard deleted dismissed memories');
    }
    return { activePruned, durablePruned, promoted };
  }

  close(): void {
    this.db.close();
  }

  private insertRecord(candidate: UserMemoryCandidate, source: UserMemoryRecord['source']): UserMemoryRecord | null {
    const now = Date.now();
    const id = generateId('mem');
    const scope = inferScope(candidate);

    this.db.insert({
      id,
      user_key: this.userKey,
      type: candidate.type,
      summary: candidate.summary.trim(),
      detail: candidate.detail?.trim() ?? null,
      scope,
      evidence_kind: candidate.evidenceKind || (source === 'conversation' ? 'inferred' : 'system'),
      source,
      confidence: clamp(candidate.confidence, 0, 1),
      importance: clamp(candidate.importance, 0, 1),
      durability: clamp(candidate.durability, 0, 1),
      evidence_count: 1,
      provenance: candidate.detail?.trim() ?? null,
      dismissed: 0,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
      last_used_at: null,
      last_used_query: null,
    });

    const row = this.db.getById(id);
    return row ? this.toRecord(row) : null;
  }

  private insertReflection(candidate: UserMemoryCandidate): void {
    const now = Date.now();
    const id = generateId('mem');

    this.db.insert({
      id,
      user_key: this.userKey,
      type: 'reflection',
      summary: candidate.summary,
      detail: candidate.detail ?? null,
      scope: 'durable',
      evidence_kind: 'system',
      source: 'system',
      confidence: candidate.confidence,
      importance: candidate.importance,
      durability: candidate.durability,
      evidence_count: 1,
      provenance: null,
      dismissed: 0,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
      last_used_at: null,
      last_used_query: null,
    });
  }

  private mergeRecord(existing: MemoryRow, candidate: UserMemoryCandidate): UserMemoryRecord | null {
    const updatedAt = Date.now();
    this.db.update({
      id: existing.id,
      summary: pickBetterSummary(existing.summary, candidate.summary),
      detail: candidate.detail || existing.detail,
      provenance: candidate.detail || existing.provenance,
      evidence_kind: candidate.evidenceKind || existing.evidence_kind,
      confidence: clamp(Math.max(existing.confidence, candidate.confidence), 0, 1),
      importance: clamp(Math.max(existing.importance, candidate.importance), 0, 1),
      durability: clamp(Math.max(existing.durability, candidate.durability), 0, 1),
      evidence_count: existing.evidence_count + 1,
      updated_at: updatedAt,
      last_seen_at: updatedAt,
    });

    const row = this.db.getById(existing.id);
    return row ? this.toRecord(row) : null;
  }

  private resolveConflict(existing: MemoryRow, candidate: UserMemoryCandidate): 'incoming' | 'existing' {
    const incomingConfidence = candidate.confidence;
    const existingConfidence = existing.confidence;

    if (incomingConfidence > existingConfidence) {
      this.db.update({
        id: existing.id,
        dismissed: 1,
        superseded_by: 'auto_resolved',
        updated_at: Date.now(),
      });
      logger.debug(
        { existingId: existing.id, existingConfidence, incomingConfidence, type: candidate.type },
        'Auto-resolved conflict: incoming wins',
      );
      return 'incoming';
    }

    if (incomingConfidence < existingConfidence) {
      logger.debug(
        { existingId: existing.id, existingConfidence, incomingConfidence, type: candidate.type },
        'Auto-resolved conflict: existing wins',
      );
      return 'existing';
    }

    this.db.update({
      id: existing.id,
      dismissed: 1,
      superseded_by: 'auto_resolved',
      updated_at: Date.now(),
    });
    logger.debug(
      { existingId: existing.id, type: candidate.type },
      'Auto-resolved conflict: equal confidence, newer wins',
    );
    return 'incoming';
  }

  private enforceMaxRecords(): void {
    const total = this.db.totalActive(this.userKey);
    if (total <= this.maxRecords) return;

    const allActive = this.db.getActive(this.userKey);
    const toDismiss = allActive
      .sort((a, b) => memoryHealthScore(b) - memoryHealthScore(a))
      .slice(this.maxRecords);

    for (const row of toDismiss) {
      this.db.softDelete(row.id);
    }

    if (toDismiss.length > 0) {
      logger.debug({ dismissed: toDismiss.length, userKey: this.userKey }, 'Enforced max records limit');
    }
  }

  private markUsed(ids: string[], query?: string): void {
    const now = Date.now();
    for (const id of ids) {
      this.db.update({
        id,
        last_used_at: now,
        last_used_query: query || undefined,
        updated_at: now,
      });
    }
  }

  private scoreAndRank(rows: MemoryRow[], query: string): MemoryRow[] {
    const now = Date.now();
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    return rows
      .map(row => {
        let score = 0;
        score += row.confidence * 0.3;
        score += row.importance * 0.25;
        score += row.durability * 0.15;
        const ageDays = (now - row.updated_at) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 0.2 - ageDays * 0.005);
        const lower = (row.summary + ' ' + (row.detail ?? '')).toLowerCase();
        const matchCount = tokens.filter(t => lower.includes(t)).length;
        score += (matchCount / Math.max(tokens.length, 1)) * 0.1;
        return { row, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(r => r.row);
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
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private indexPersonsForMemory(memory: UserMemoryRecord): void {
    const row = this.db.getById(memory.id);
    if (row) this.indexPersonsForMemoryRow(row);
  }

  private indexPersonsForMemoryRow(memory: MemoryRow): void {
    if (memory.dismissed === 1) return;
    if (!['relationship', 'episode'].includes(memory.type)) return;

    const text = `${memory.summary} ${memory.detail ?? ''}`.trim();
    if (!text) return;

    this.db.clearMemoryPersons(memory.id);
    this.db.clearRelationshipsByMemory(memory.id);

    if (memory.type === 'relationship') {
      const relationMentions = extractUserRelationshipMentions(text);
      for (const mention of relationMentions) {
        const person = this.db.upsertPerson({
          userKey: this.userKey,
          name: mention.name,
          relationshipToUser: mention.relation,
          confidence: memory.confidence,
        });
        this.db.addPersonAlias(person.id, mention.name, 'memory');
        this.db.linkMemoryPerson(memory.id, person.id, 'relationship', memory.confidence);
      }
      return;
    }

    const knownPersons = this.db.listPersons(this.userKey, '', 300);
    if (knownPersons.length === 0) return;
    for (const person of knownPersons) {
      if (mentionsPerson(text, person.display_name) || mentionsPerson(text, person.canonical_name)) {
        this.db.linkMemoryPerson(memory.id, person.id, 'interaction', memory.confidence);
      }
    }
  }

  private toRecord(row: MemoryRow): UserMemoryRecord {
    return {
      id: row.id,
      type: row.type as UserMemoryType,
      summary: row.summary,
      detail: row.detail,
      scope: row.scope as 'durable' | 'active',
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

const USER_RELATION_ROLE_MAP: Record<string, string> = {
  wife: 'wife',
  husband: 'husband',
  mother: 'mother',
  mom: 'mother',
  father: 'father',
  dad: 'father',
  brother: 'family',
  sister: 'family',
  son: 'family',
  daughter: 'family',
  family: 'family',
  cousin: 'family',
  friend: 'friend',
  colleague: 'colleague',
  coworker: 'colleague',
  teammate: 'colleague',
};

const NON_PERSON_TERMS = new Set([
  'I', 'The', 'This', 'That', 'Today', 'Tomorrow', 'Yesterday', 'Monday', 'Tuesday',
  'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February',
  'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December', 'Mercury', 'Openai', 'Anthropic',
]);

interface UserRelationMention {
  name: string;
  relation: string;
}

function extractUserRelationshipMentions(text: string): UserRelationMention[] {
  const mentions = new Map<string, UserRelationMention>();
  const rolePattern = Object.keys(USER_RELATION_ROLE_MAP).join('|');
  const normalizedText = text.replace(/[\r\n]+/g, ' ').trim();

  const patterns = [
    new RegExp(`\\bmy\\s+(${rolePattern})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b`, 'gi'),
    new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s+is\\s+my\\s+(${rolePattern})\\b`, 'gi'),
    new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s*,\\s*my\\s+(${rolePattern})\\b`, 'gi'),
    new RegExp(`\\bmy\\s+(${rolePattern})\\s*,\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b`, 'gi'),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalizedText)) !== null) {
      const first = match[1]?.trim();
      const second = match[2]?.trim();
      if (!first || !second) continue;

      const firstIsRole = USER_RELATION_ROLE_MAP[first.toLowerCase()];
      const role = firstIsRole ? first.toLowerCase() : second.toLowerCase();
      const name = firstIsRole ? second : first;
      const relation = USER_RELATION_ROLE_MAP[role];
      if (!relation || !isLikelyHumanName(name)) continue;

      const key = name.toLowerCase();
      mentions.set(key, { name, relation });
    }
  }

  return [...mentions.values()];
}

function isLikelyHumanName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 48) return false;
  if (NON_PERSON_TERMS.has(name)) return false;
  const parts = name.split(' ').filter(Boolean);
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

function shouldStoreCandidate(candidate: UserMemoryCandidate): boolean {
  const summary = candidate.summary.trim();
  if (summary.length < 12 || summary.length > 220) return false;
  if (candidate.confidence < MIN_CONFIDENCE) return false;
  if (candidate.durability < 0.4 && candidate.importance < 0.7) return false;
  return true;
}

function findMergeTarget(rows: MemoryRow[], candidate: UserMemoryCandidate): MemoryRow | undefined {
  const normalizedCandidate = normalize(candidate.summary);
  return rows.find(row => {
    if (row.type !== candidate.type) return false;
    if (hasConflict(row.summary, candidate.summary)) return false;
    const normalizedRow = normalize(row.summary);
    if (normalizedRow === normalizedCandidate) return true;
    return overlapScore(normalizedRow, normalizedCandidate) >= 0.74;
  });
}

function memoryHealthScore(row: MemoryRow): number {
  return (row.importance * 0.35)
    + (row.durability * 0.25)
    + (effectiveConfidence(row) * 0.25)
    + (Math.min(row.evidence_count, 5) / 5 * 0.15)
    + (row.scope === 'active' ? 0.08 : 0)
    - (row.superseded_by ? 0.3 : 0)
    - (isRowStale(row) ? 0.12 : 0);
}

function effectiveConfidence(row: MemoryRow): number {
  const ageDays = (Date.now() - row.updated_at) / (1000 * 60 * 60 * 24);
  let confidence = row.confidence;

  if (row.evidence_kind === 'inferred') {
    confidence -= Math.min(0.2, ageDays / 365);
  } else if (row.evidence_kind === 'manual') {
    confidence += 0.06;
  } else if (row.evidence_kind === 'direct') {
    confidence += 0.03;
  }

  if (row.scope === 'active') {
    confidence -= Math.min(0.18, ageDays / 120);
  }

  return clamp(confidence, 0, 1);
}

function isRowStale(row: MemoryRow): boolean {
  const ageDays = (Date.now() - row.updated_at) / (1000 * 60 * 60 * 24);
  if (row.scope === 'active') {
    return ageDays > 21;
  }
  if (row.evidence_kind === 'inferred') {
    return ageDays > 120;
  }
  return ageDays > 365;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(term => term.trim())
    .filter(term => term.length >= 3);
}

function normalize(input: string): string {
  return tokenize(input).join(' ');
}

function overlapScore(a: string, b: string): number {
  const aTerms = new Set(a.split(' ').filter(Boolean));
  const bTerms = new Set(b.split(' ').filter(Boolean));
  if (aTerms.size === 0 || bTerms.size === 0) return 0;

  let overlap = 0;
  for (const term of aTerms) {
    if (bTerms.has(term)) overlap += 1;
  }
  return overlap / Math.max(aTerms.size, bTerms.size);
}

function pickBetterSummary(existing: string, incoming: string): string {
  return incoming.length > existing.length && incoming.length <= 220 ? incoming.trim() : existing.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function inferScope(candidate: UserMemoryCandidate): 'durable' | 'active' {
  if (['goal', 'project', 'decision', 'episode'].includes(candidate.type)) {
    return 'active';
  }
  return 'durable';
}

function hasConflict(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return false;

  const polarityPairs = [
    ['prefers', 'does not prefer'],
    ['likes', 'does not like'],
    ['wants', 'does not want'],
    ['is building', 'is not building'],
    ['uses', 'does not use'],
    ['enabled', 'disabled'],
  ];

  for (const [positive, negative] of polarityPairs) {
    const leftPosRightNeg = left.includes(positive) && right.includes(negative);
    const leftNegRightPos = left.includes(negative) && right.includes(positive);
    if (leftPosRightNeg || leftNegRightPos) {
      return overlapScore(
        normalize(left.replace(positive, '').replace(negative, '')),
        normalize(right.replace(positive, '').replace(negative, '')),
      ) >= 0.5;
    }
  }

  const leftHasNegation = /\b(not|never|no longer|avoid|against|disabled)\b/.test(left);
  const rightHasNegation = /\b(not|never|no longer|avoid|against|disabled)\b/.test(right);
  if (leftHasNegation !== rightHasNegation) {
    return overlapScore(normalize(left), normalize(right)) >= 0.7;
  }

  return false;
}

function buildProfileSummary(records: MemoryRow[]): string {
  const selected: string[] = [];
  const preferredTypes: string[] = ['identity', 'preference', 'goal', 'project', 'constraint', 'habit'];

  for (const type of preferredTypes) {
    const match = records
      .filter(r => r.type === type)
      .sort((a, b) => memoryHealthScore(b) - memoryHealthScore(a))[0];
    if (match && !selected.includes(match.summary)) {
      selected.push(match.summary);
    }
    if (selected.length >= 4) break;
  }

  return selected.join(' ').slice(0, 420).trim();
}

function buildActiveSummary(records: MemoryRow[]): string {
  const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const activeCandidates = records
    .filter(r => !r.superseded_by)
    .filter(r => !isRowStale(r))
    .filter(r => r.updated_at >= cutoff)
    .filter(r => ['goal', 'project', 'decision', 'episode'].includes(r.type))
    .sort((a, b) => {
      const byUpdated = b.updated_at - a.updated_at;
      if (byUpdated !== 0) return byUpdated;
      return memoryHealthScore(b) - memoryHealthScore(a);
    })
    .slice(0, 3)
    .map(r => r.summary);
  return activeCandidates.join(' ').slice(0, 360).trim();
}

function buildReflectionCandidates(records: MemoryRow[]): UserMemoryCandidate[] {
  const candidates: UserMemoryCandidate[] = [];
  const groups = new Map<string, MemoryRow[]>();

  for (const record of records) {
    if (!groups.has(record.type)) groups.set(record.type, []);
    groups.get(record.type)!.push(record);
  }

  const prefGroup = groups.get('preference') || [];
  if (prefGroup.length >= 2) {
    const top = prefGroup
      .sort((a, b) => memoryHealthScore(b) - memoryHealthScore(a))
      .slice(0, 2)
      .map(r => r.summary);
    candidates.push({
      type: 'reflection',
      summary: `User consistently shows these preferences: ${top.join(' ')}`.slice(0, 220),
      detail: top.join('\n'),
      confidence: 0.86,
      importance: 0.86,
      durability: 0.9,
    });
  }

  const goalProjectGroup = [...(groups.get('goal') || []), ...(groups.get('project') || [])];
  if (goalProjectGroup.length >= 2) {
    const top = goalProjectGroup
      .sort((a, b) => memoryHealthScore(b) - memoryHealthScore(a))
      .slice(0, 2)
      .map(r => r.summary);
    candidates.push({
      type: 'reflection',
      summary: `Current long-term direction: ${top.join(' ')}`.slice(0, 220),
      detail: top.join('\n'),
      confidence: 0.84,
      importance: 0.9,
      durability: 0.86,
    });
  }

  const habitConstraintGroup = [...(groups.get('habit') || []), ...(groups.get('constraint') || [])];
  if (habitConstraintGroup.length >= 2) {
    const top = habitConstraintGroup
      .sort((a, b) => memoryHealthScore(b) - memoryHealthScore(a))
      .slice(0, 2)
      .map(r => r.summary);
    candidates.push({
      type: 'reflection',
      summary: `Working style pattern: ${top.join(' ')}`.slice(0, 220),
      detail: top.join('\n'),
      confidence: 0.82,
      importance: 0.8,
      durability: 0.82,
    });
  }

  return candidates;
}
