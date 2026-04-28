import type { MercuryConfig } from '../utils/config.js';
import { getMemoryDir } from '../utils/config.js';
import { SharedMemoryDB, type SharedMemoryRow } from './shared-memory-db.js';
import type { RelayFriendRequest } from '../relay/relay-client.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export type SharedMemoryType =
  | 'identity'
  | 'preference'
  | 'goal'
  | 'project'
  | 'habit'
  | 'decision'
  | 'constraint'
  | 'relationship'
  | 'episode';

interface SharedMemoryRecord {
  id: string;
  type: SharedMemoryType;
  category: string;
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

export interface SharedMemoryCandidate {
  type: SharedMemoryType;
  category: string;
  summary: string;
  detail?: string;
  evidenceKind?: 'direct' | 'inferred';
  confidence: number;
  importance: number;
  durability: number;
}

export interface SharedMemorySummary {
  total: number;
  byType: Partial<Record<SharedMemoryType, number>>;
  categories: string[];
  learningPaused: boolean;
  friendCount: number;
}

export type FriendStatus = 'pending' | 'awaiting_negative_list' | 'approved' | 'rejected' | 'revoked';

export interface FriendInfo {
  tgId: string;
  requestId: string;
  username: string | null;
  firstName: string | null;
  direction: 'sent' | 'received';
  status: FriendStatus;
  negativeTags: string[];
  negativeRules: string | null;
  createdAt: number;
  approvedAt: number | null;
}

interface SharedMemoryQueryResult {
  records: SharedMemoryRecord[];
  context: string;
  blocked: boolean;
}

const MIN_CONFIDENCE = 0.55;
const MAX_QUERIES_PER_HOUR = 25;

export class SharedMemoryStore {
  private db: SharedMemoryDB;
  private maxRecords: number;
  private userKey: string;
  private friendsCache: Map<string, FriendInfo> = new Map();
  private friendQueryCounts: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(config: MercuryConfig, userKey: string = 'user:owner', dbPath?: string) {
    this.userKey = userKey;
    this.maxRecords = config.memory.sharedMemory?.maxRecords ?? 100;
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'shared-memory', 'shared-memory.db');
    this.db = new SharedMemoryDB(resolvedDbPath);
    this.db.init();
  }

  getSummary(): SharedMemorySummary {
    const byType = this.db.countByType(this.userKey) as Partial<Record<SharedMemoryType, number>>;
    return {
      total: this.db.totalActive(this.userKey),
      byType,
      categories: this.db.getCategories(this.userKey),
      learningPaused: this.isLearningPaused(),
      friendCount: Array.from(this.friendsCache.values()).filter(f => f.status === 'approved').length,
    };
  }

  getRecent(limit: number = 10): SharedMemoryRecord[] {
    return this.db.getActive(this.userKey).slice(0, limit).map(row => this.toRecord(row));
  }

  search(query: string, limit: number = 10): SharedMemoryRecord[] {
    const rows = this.db.searchRelevant(this.userKey, query, limit);
    return rows.map(row => this.toRecord(row));
  }

  retrieveRelevant(
    query: string,
    options?: { maxRecords?: number; maxChars?: number },
  ): SharedMemoryQueryResult {
    const maxRecords = options?.maxRecords ?? 5;
    const maxChars = options?.maxChars ?? 900;

    const ftsResults = this.db.searchRelevant(this.userKey, query, Math.max(maxRecords * 2, 10));
    const ranked = this.scoreAndRank(ftsResults, query);

    const selected: SharedMemoryRow[] = [];
    let currentLength = 0;
    for (const row of ranked) {
      const line = `- [${row.type}|${row.category}] ${row.summary}`;
      if (selected.length >= maxRecords) break;
      if (selected.length > 0 && currentLength + line.length > maxChars) break;
      selected.push(row);
      currentLength += line.length + 1;
    }

    if (selected.length === 0) {
      return { records: [], context: '', blocked: false };
    }

    const contextLines = [
      'Shared memory (owner\'s shared knowledge):',
      ...selected.map(row => `- [${row.type}|${row.category}] ${row.summary}`),
    ];

    this.markUsed(selected.map(r => r.id), query);
    return {
      records: selected.map(r => this.toRecord(r)),
      context: contextLines.join('\n'),
      blocked: false,
    };
  }

  retrieveForFriend(
    friendTgId: string,
    query: string,
    options?: { maxRecords?: number; maxChars?: number },
  ): SharedMemoryQueryResult {
    const friend = this.friendsCache.get(friendTgId);
    if (!friend || friend.status !== 'approved') {
      return { records: [], context: 'Access denied — friend not approved or not found.', blocked: true };
    }

    const queryCount = this.incrementFriendQueryCount(friendTgId);
    if (queryCount > MAX_QUERIES_PER_HOUR) {
      return {
        records: [],
        context: 'Rate limit exceeded — maximum 25 queries per hour.',
        blocked: true,
      };
    }

    const maxRecords = options?.maxRecords ?? 5;
    const maxChars = options?.maxChars ?? 900;

    const negativeTags = friend.negativeTags;
    const negativeRules = friend.negativeRules;

    let results = this.db.searchRelevantForFriend(
      this.userKey, query, negativeTags, Math.max(maxRecords * 2, 10)
    );

    if (negativeRules) {
      results = this.applyLLMScrub(results, negativeRules);
    }

    const ranked = this.scoreAndRank(results, query);
    const selected: SharedMemoryRow[] = [];
    let currentLength = 0;

    for (const row of ranked) {
      const line = `- [${row.type}|${row.category}] ${row.summary}`;
      if (selected.length >= maxRecords) break;
      if (selected.length > 0 && currentLength + line.length > maxChars) break;
      selected.push(row);
      currentLength += line.length + 1;
    }

    if (selected.length === 0) {
      return { records: [], context: 'No relevant shared memories found (or filtered by negative list).', blocked: false };
    }

    const contextLines = [
      'Shared memory from this agent\'s owner:',
      ...selected.map(row => `- [${row.type}|${row.category}] ${row.summary}`),
    ];

    this.markUsed(selected.map(r => r.id), query);
    return {
      records: selected.map(r => this.toRecord(r)),
      context: contextLines.join('\n'),
      blocked: false,
    };
  }

  resolveCategory(rawCategory: string): string {
    const normalized = rawCategory.trim().toLowerCase();
    if (!normalized) return 'general';

    const existing = this.db.findBestCategoryMatch(this.userKey, normalized);
    if (existing) return existing;

    this.db.addCategory(this.userKey, normalized);
    logger.info({ category: normalized }, 'New shared memory category created');
    return normalized;
  }

  remember(
    candidates: SharedMemoryCandidate[],
    source: SharedMemoryRecord['source'] = 'conversation',
  ): SharedMemoryRecord[] {
    if (this.isLearningPaused()) return [];

    const remembered: SharedMemoryRecord[] = [];

    for (const candidate of candidates) {
      if (!shouldStoreCandidate(candidate)) continue;

      const resolvedCategory = this.resolveCategory(candidate.category);

      const terms = normalize(candidate.summary).split(/\s+/).filter(t => t.length > 2);

      const mergeTarget = this.db.findMergeCandidate(this.userKey, candidate.type, terms);
      if (mergeTarget && overlapScore(normalize(mergeTarget.summary), normalize(candidate.summary)) >= 0.74) {
        const merged = this.mergeRecord(mergeTarget, candidate, resolvedCategory);
        if (merged) remembered.push(merged);
        continue;
      }

      const conflictTarget = this.db.findConflictCandidate(this.userKey, candidate.type, terms);
      if (conflictTarget) {
        const conflictWinner = this.resolveConflict(conflictTarget, candidate);
        if (conflictWinner === 'existing') continue;
      }

      const record = this.insertRecord(candidate, resolvedCategory, source);
      if (record) remembered.push(record);
    }

    this.enforceMaxRecords();

    return remembered;
  }

  syncFriendsFromRelay(relayFriends: RelayFriendRequest[], localTgId: string): void {
    this.friendsCache.clear();
    for (const rf of relayFriends) {
      const isSender = rf.from_tg_id === localTgId;
      const friendTgId = isSender ? rf.to_tg_id : rf.from_tg_id;
      const friendInfo: FriendInfo = {
        tgId: friendTgId,
        requestId: rf.id,
        username: isSender ? rf.to_username : rf.from_username,
        firstName: isSender ? rf.to_first_name : rf.from_first_name,
        direction: isSender ? 'sent' : 'received',
        status: rf.status as FriendStatus,
        negativeTags: rf.negative_tags ? JSON.parse(rf.negative_tags) : [],
        negativeRules: rf.negative_rules,
        createdAt: rf.created_at,
        approvedAt: rf.approved_at,
      };
      this.friendsCache.set(friendTgId, friendInfo);
    }
    logger.info({ count: this.friendsCache.size }, 'Friends cache synced from relay');
  }

  upsertFriendFromRelayEvent(
    friendTgId: string,
    requestId: string,
    direction: 'sent' | 'received',
    status: FriendStatus,
    username?: string | null,
    firstName?: string | null,
  ): FriendInfo {
    const existing = this.friendsCache.get(friendTgId);
    const info: FriendInfo = {
      tgId: friendTgId,
      requestId: requestId || existing?.requestId || '',
      username: username ?? existing?.username ?? null,
      firstName: firstName ?? existing?.firstName ?? null,
      direction,
      status,
      negativeTags: status === 'approved' ? (existing?.negativeTags ?? []) : [],
      negativeRules: status === 'approved' ? (existing?.negativeRules ?? null) : null,
      createdAt: existing?.createdAt ?? Date.now(),
      approvedAt: status === 'approved' ? (existing?.approvedAt ?? Date.now()) : null,
    };
    this.friendsCache.set(friendTgId, info);
    return info;
  }

  removeFriendFromCache(tgId: string): FriendInfo | null {
    const friend = this.friendsCache.get(tgId);
    if (!friend) return null;
    this.friendsCache.delete(tgId);
    return friend;
  }

  updateFriendStatusInCache(tgId: string, status: FriendStatus): FriendInfo | null {
    const friend = this.friendsCache.get(tgId);
    if (!friend) return null;
    friend.status = status;
    return friend;
  }

  approveFriendInCache(tgId: string, negativeTags: string[], negativeRules?: string): FriendInfo | null {
    const friend = this.friendsCache.get(tgId);
    if (!friend) return null;
    friend.status = 'approved';
    friend.negativeTags = negativeTags;
    friend.negativeRules = negativeRules ?? null;
    friend.approvedAt = Date.now();
    return friend;
  }

  updateFriendNegativeListInCache(tgId: string, negativeTags: string[], negativeRules?: string): FriendInfo | null {
    const friend = this.friendsCache.get(tgId);
    if (!friend || (friend.status !== 'approved' && friend.status !== 'awaiting_negative_list')) return null;
    friend.negativeTags = negativeTags;
    friend.negativeRules = negativeRules ?? friend.negativeRules;
    return friend;
  }

  getFriends(): FriendInfo[] {
    return Array.from(this.friendsCache.values());
  }

  getFriendsByStatus(status: FriendStatus): FriendInfo[] {
    return Array.from(this.friendsCache.values()).filter(f => f.status === status);
  }

  getFriend(tgId: string): FriendInfo | null {
    return this.friendsCache.get(tgId) ?? null;
  }

  isFriendApproved(tgId: string): boolean {
    const friend = this.friendsCache.get(tgId);
    return friend?.status === 'approved';
  }

  getCategories(): string[] {
    return this.db.getCategories(this.userKey);
  }

  setLearningPaused(paused: boolean): void {
    this.db.setMeta(`${this.userKey}:shared_learning_paused`, paused ? '1' : '0');
  }

  isLearningPaused(): boolean {
    return this.db.getMeta(`${this.userKey}:shared_learning_paused`) === '1';
  }

  clear(): number {
    return this.db.clearByType(this.userKey);
  }

  close(): void {
    this.db.close();
  }

  private applyLLMScrub(rows: SharedMemoryRow[], negativeRules: string): SharedMemoryRow[] {
    logger.debug({ negativeRules, count: rows.length }, 'LLM scrub would be applied (not yet implemented — returning tag-filtered results only)');
    return rows;
  }

  private insertRecord(candidate: SharedMemoryCandidate, category: string, source: SharedMemoryRecord['source']): SharedMemoryRecord | null {
    const now = Date.now();
    const id = generateId('smem');
    const scope = inferScope(candidate);

    this.db.insert({
      id,
      user_key: this.userKey,
      type: candidate.type,
      category,
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

  private mergeRecord(existing: SharedMemoryRow, candidate: SharedMemoryCandidate, category: string): SharedMemoryRecord | null {
    const updatedAt = Date.now();
    this.db.update({
      id: existing.id,
      category: category,
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

  private resolveConflict(existing: SharedMemoryRow, candidate: SharedMemoryCandidate): 'incoming' | 'existing' {
    const incomingConfidence = candidate.confidence;
    const existingConfidence = existing.confidence;

    if (incomingConfidence > existingConfidence) {
      this.db.update({
        id: existing.id,
        dismissed: 1,
        superseded_by: 'auto_resolved',
        updated_at: Date.now(),
      });
      return 'incoming';
    }

    if (incomingConfidence < existingConfidence) {
      return 'existing';
    }

    this.db.update({
      id: existing.id,
      dismissed: 1,
      superseded_by: 'auto_resolved',
      updated_at: Date.now(),
    });
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
      logger.debug({ dismissed: toDismiss.length, userKey: this.userKey }, 'Enforced max shared memory records limit');
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

  private scoreAndRank(rows: SharedMemoryRow[], query: string): SharedMemoryRow[] {
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

  private toRecord(row: SharedMemoryRow): SharedMemoryRecord {
    return {
      id: row.id,
      type: row.type as SharedMemoryType,
      category: row.category,
      summary: row.summary,
      detail: row.detail,
      scope: row.scope as 'durable' | 'active',
      evidenceKind: row.evidence_kind as SharedMemoryRecord['evidenceKind'],
      source: row.source as SharedMemoryRecord['source'],
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

  private incrementFriendQueryCount(tgId: string): number {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const entry = this.friendQueryCounts.get(tgId);
    let count = 0;
    let resetAt = now;

    if (entry && now - entry.resetAt < oneHour) {
      count = entry.count;
      resetAt = entry.resetAt;
    }

    count += 1;
    this.friendQueryCounts.set(tgId, { count, resetAt });
    return count;
  }
}

function shouldStoreCandidate(candidate: SharedMemoryCandidate): boolean {
  const summary = candidate.summary.trim();
  if (summary.length < 12 || summary.length > 220) return false;
  if (candidate.confidence < MIN_CONFIDENCE) return false;
  if (candidate.durability < 0.4 && candidate.importance < 0.7) return false;
  return true;
}

function memoryHealthScore(row: SharedMemoryRow): number {
  return (row.importance * 0.35)
    + (row.durability * 0.25)
    + (row.confidence * 0.25)
    + (Math.min(row.evidence_count, 5) / 5 * 0.15)
    - (row.superseded_by ? 0.3 : 0);
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
    .join(' ');
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

function inferScope(candidate: SharedMemoryCandidate): 'durable' | 'active' {
  if (['goal', 'project', 'decision', 'episode'].includes(candidate.type)) {
    return 'active';
  }
  return 'durable';
}