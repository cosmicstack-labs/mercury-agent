import type { MercuryConfig } from '../utils/config.js';
import { getMemoryDir } from '../utils/config.js';
import { CollaborativeKnowledgeDB, type CollaborativeKnowledgeRow } from './collaborative-knowledge-db.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export type CollaborativeKnowledgeType =
  | 'identity'
  | 'preference'
  | 'goal'
  | 'project'
  | 'habit'
  | 'decision'
  | 'constraint'
  | 'relationship'
  | 'episode';

export interface CollaborativeKnowledgeRecord {
  id: string;
  type: CollaborativeKnowledgeType;
  category: string;
  summary: string;
  detail?: string | null;
  evidenceKind: 'direct' | 'inferred';
  confidence: number;
  importance: number;
  durability: number;
  evidenceCount: number;
  dismissed: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  lastUsedAt?: number | null;
  lastUsedQuery?: string | null;
}

export interface CollaborativeKnowledgeCandidate {
  type: CollaborativeKnowledgeType;
  category: string;
  summary: string;
  detail?: string;
  evidenceKind?: 'direct' | 'inferred';
  confidence: number;
  importance: number;
  durability: number;
}

export interface CollaborativeKnowledgeSummary {
  total: number;
  byType: Partial<Record<CollaborativeKnowledgeType, number>>;
  byCategory: Record<string, number>;
  categories: string[];
  learningPaused: boolean;
}

const MIN_CONFIDENCE = 0.55;

export class CollaborativeKnowledgeStore {
  private db: CollaborativeKnowledgeDB;

  constructor(config: MercuryConfig, dbPath?: string) {
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'ck', 'collaborative-knowledge.db');
    this.db = new CollaborativeKnowledgeDB(resolvedDbPath);
    this.db.init();
  }

  getSummary(): CollaborativeKnowledgeSummary {
    const byType = this.db.countByType() as Partial<Record<CollaborativeKnowledgeType, number>>;
    const byCategory = this.db.countByCategory();
    return {
      total: this.db.totalActive(),
      byType,
      byCategory,
      categories: this.db.getCategories(),
      learningPaused: this.isLearningPaused(),
    };
  }

  getRecent(limit: number = 10): CollaborativeKnowledgeRecord[] {
    return this.db.getActive().slice(0, limit).map(row => this.toRecord(row));
  }

  search(query: string, limit: number = 10): CollaborativeKnowledgeRecord[] {
    const rows = this.db.searchRelevant(query, limit);
    return rows.map(row => this.toRecord(row));
  }

  retrieveRelevant(
    query: string,
    options?: { maxRecords?: number; maxChars?: number },
  ): { records: CollaborativeKnowledgeRecord[]; context: string } {
    const maxRecords = options?.maxRecords ?? 5;
    const maxChars = options?.maxChars ?? 900;

    const ftsResults = this.db.searchRelevant(query, Math.max(maxRecords * 2, 10));
    const ranked = this.scoreAndRank(ftsResults, query);

    const selected: CollaborativeKnowledgeRow[] = [];
    let currentLength = 0;
    for (const row of ranked) {
      const line = `- [${row.type}|${row.category}] ${row.summary}`;
      if (selected.length >= maxRecords) break;
      if (selected.length > 0 && currentLength + line.length > maxChars) break;
      selected.push(row);
      currentLength += line.length + 1;
    }

    if (selected.length === 0) {
      return { records: [], context: '' };
    }

    const contextLines = [
      'Collaborative knowledge (your shared knowledge pool):',
      ...selected.map(row => `- [${row.type}|${row.category}] ${row.summary}`),
    ];

    this.markUsed(selected.map(r => r.id), query);
    return { records: selected.map(r => this.toRecord(r)), context: contextLines.join('\n') };
  }

  resolveCategory(rawCategory: string): string {
    const normalized = rawCategory.trim().toLowerCase();
    if (!normalized) return 'general';

    const existing = this.db.findBestCategoryMatch(normalized);
    if (existing) return existing;

    this.db.addCategory(normalized);
    logger.info({ category: normalized }, 'New collaborative knowledge category created');
    return normalized;
  }

  remember(
    candidates: CollaborativeKnowledgeCandidate[],
  ): CollaborativeKnowledgeRecord[] {
    if (this.isLearningPaused()) return [];

    const remembered: CollaborativeKnowledgeRecord[] = [];

    for (const candidate of candidates) {
      if (!shouldStoreCandidate(candidate)) continue;

      const resolvedCategory = this.resolveCategory(candidate.category);

      const terms = normalize(candidate.summary).split(/\s+/).filter(t => t.length > 2);

      const mergeTarget = this.db.findMergeCandidate(candidate.type, terms);
      if (mergeTarget && overlapScore(normalize(mergeTarget.summary), normalize(candidate.summary)) >= 0.74) {
        const merged = this.mergeRecord(mergeTarget, candidate, resolvedCategory);
        if (merged) remembered.push(merged);
        continue;
      }

      const conflictTarget = this.db.findConflictCandidate(candidate.type, terms);
      if (conflictTarget) {
        const conflictWinner = this.resolveConflict(conflictTarget, candidate);
        if (conflictWinner === 'existing') continue;
      }

      const record = this.insertRecord(candidate, resolvedCategory);
      if (record) remembered.push(record);
    }

    return remembered;
  }

  getCategories(): string[] {
    return this.db.getCategories();
  }

  setLearningPaused(paused: boolean): void {
    this.db.setMeta('learning_paused', paused ? '1' : '0');
  }

  isLearningPaused(): boolean {
    return this.db.getMeta('learning_paused') === '1';
  }

  clear(): number {
    return this.db.clearByType();
  }

  close(): void {
    this.db.close();
  }

  /** Direct insert for manual/API creation — bypasses learning pause and candidate validation. */
  manualInsert(candidate: CollaborativeKnowledgeCandidate): CollaborativeKnowledgeRecord | null {
    const resolvedCategory = this.resolveCategory(candidate.category);
    return this.insertRecord(candidate, resolvedCategory);
  }

  pruneEmptyCategories(): void {
    this.db.pruneEmptyCategories();
  }

  // --- Friend Access Control ---

  getAllowedCategories(friend: string): string[] {
    return this.db.getAllowedCategories(friend);
  }

  grantCategory(friend: string, category: string): void {
    this.db.grantCategory(friend, category);
  }

  revokeCategory(friend: string, category: string): void {
    this.db.revokeCategory(friend, category);
  }

  grantAllCategories(friend: string): void {
    const categories = this.getCategories();
    this.db.grantAllCategories(friend, categories);
  }

  revokeAllCategories(friend: string): void {
    this.db.revokeAllCategories(friend);
  }

  setFriendAccess(friend: string, categories: string[]): void {
    this.db.revokeAllCategories(friend);
    for (const cat of categories) {
      this.db.grantCategory(friend, cat);
    }
  }

  getFriendAccessMap(): Record<string, string[]> {
    return this.db.getFriendAccessMap();
  }

  private insertRecord(candidate: CollaborativeKnowledgeCandidate, category: string): CollaborativeKnowledgeRecord | null {
    const now = Date.now();
    const id = generateId('ck');

    this.db.insert({
      id,
      type: candidate.type,
      category,
      summary: candidate.summary.trim(),
      detail: candidate.detail?.trim() ?? null,
      evidence_kind: candidate.evidenceKind || 'inferred',
      confidence: clamp(candidate.confidence, 0, 1),
      importance: clamp(candidate.importance, 0, 1),
      durability: clamp(candidate.durability, 0, 1),
      evidence_count: 1,
      dismissed: 0,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
      last_used_at: null,
      last_used_query: null,
    });

    const row = this.db.getById(id);
    return row ? this.toRecord(row) : null;
  }

  private mergeRecord(existing: CollaborativeKnowledgeRow, candidate: CollaborativeKnowledgeCandidate, category: string): CollaborativeKnowledgeRecord | null {
    const updatedAt = Date.now();
    this.db.update({
      id: existing.id,
      category,
      summary: pickBetterSummary(existing.summary, candidate.summary),
      detail: candidate.detail || existing.detail,
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

  private resolveConflict(existing: CollaborativeKnowledgeRow, candidate: CollaborativeKnowledgeCandidate): 'incoming' | 'existing' {
    if (candidate.confidence > existing.confidence) {
      this.db.update({
        id: existing.id,
        dismissed: 1,
        updated_at: Date.now(),
      });
      return 'incoming';
    }

    if (candidate.confidence < existing.confidence) {
      return 'existing';
    }

    this.db.update({
      id: existing.id,
      dismissed: 1,
      updated_at: Date.now(),
    });
    return 'incoming';
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

  private scoreAndRank(rows: CollaborativeKnowledgeRow[], query: string): CollaborativeKnowledgeRow[] {
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

  private toRecord(row: CollaborativeKnowledgeRow): CollaborativeKnowledgeRecord {
    return {
      id: row.id,
      type: row.type as CollaborativeKnowledgeType,
      category: row.category,
      summary: row.summary,
      detail: row.detail,
      evidenceKind: row.evidence_kind as 'direct' | 'inferred',
      confidence: row.confidence,
      importance: row.importance,
      durability: row.durability,
      evidenceCount: row.evidence_count,
      dismissed: row.dismissed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeenAt: row.last_seen_at,
      lastUsedAt: row.last_used_at,
      lastUsedQuery: row.last_used_query,
    };
  }
}

function shouldStoreCandidate(candidate: CollaborativeKnowledgeCandidate): boolean {
  const summary = candidate.summary.trim();
  if (summary.length < 12 || summary.length > 220) return false;
  if (candidate.confidence < MIN_CONFIDENCE) return false;
  if (candidate.durability < 0.4 && candidate.importance < 0.7) return false;
  return true;
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