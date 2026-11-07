import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MercuryConfig } from './config.js';
import { getMercuryHome, saveConfig } from './config.js';
import { logger } from './logger.js';
import { formatNumber } from './format.js';
import { recordDay, seedToday } from './token-history.js';

export interface TokenTracker {
  dailyUsed: number;
  dailyBudget: number;
  lastResetDate: string;
  requestLog: TokenLogEntry[];
  /** Today's cache split, for /budget. Absent in files written before it existed. */
  dailySplit?: DailySplit;
}

/** Today's input/output split across every recorded request. */
export interface DailySplit {
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Input tokens billed at the full rate. */
  noCacheInputTokens: number;
  outputTokens: number;
}

export interface TokenLogEntry {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  channelType: string;
  agentId?: string;
  /** Cache-hit input tokens, when the caller knows the split. */
  cachedInputTokens?: number;
  /** Full-rate input tokens, when the caller knows the split. */
  noCacheInputTokens?: number;
  /**
   * What this request added to `dailyUsed`: `totalTokens`, or with a cache
   * split, uncached input + output + cache hits × `tokens.cachedWeight`.
   */
  countedTokens?: number;
}

const TOKEN_FILE = 'token-usage.json';

function safeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

const emptySplit = (): DailySplit => ({ inputTokens: 0, cachedInputTokens: 0, noCacheInputTokens: 0, outputTokens: 0 });

/** `tokens.cachedWeight`, clamped to 0–1; anything non-numeric is 1 (count everything). */
export function cachedWeightOf(config: MercuryConfig): number {
  const raw = (config.tokens as { cachedWeight?: unknown } | undefined)?.cachedWeight;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Tokens one request adds to the daily budget. Without a cache split this is
 * the plain total; with one, cache hits count at `weight`.
 */
export function countedTokensFor(
  entry: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number },
  weight: number,
): number {
  if (entry.cachedInputTokens === undefined) return entry.totalTokens;
  const cached = Math.min(entry.inputTokens, Math.max(0, entry.cachedInputTokens));
  const uncached = Math.max(0, entry.inputTokens - cached);
  return Math.round(uncached + entry.outputTokens + cached * weight);
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export class TokenBudget {
  private dailyUsed = 0;
  /** Today's cache split (resets daily). */
  private dailySplit: DailySplit = emptySplit();
  private dailyBudget: number;
  private lastResetDate: string;
  private requestLog: TokenLogEntry[] = [];
  private forceNext = false;
  private perAgentUsage: Map<string, number> = new Map();
  /** Estimated tokens saved today by saver mode (resets daily). */
  private dailySaved = 0;
  /** Cumulative lifetime estimated tokens saved (persisted). */
  private lifetimeSaved = 0;

  constructor(private config: MercuryConfig) {
    this.dailyBudget = config.tokens.dailyBudget;
    this.lastResetDate = new Date().toISOString().split('T')[0];
    const lifetime = (config.tokens as any).saverTokensSavedLifetime;
    if (typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0) {
      this.lifetimeSaved = lifetime;
    }
    this.restore();
    // The ledger starts with today's counter on its first run, so today isn't blank.
    if (this.dailyUsed > 0) {
      const input = this.requestLog.reduce((a, e) => a + safeNumber(e.inputTokens), 0);
      const output = this.requestLog.reduce((a, e) => a + safeNumber(e.outputTokens), 0);
      seedToday(this.dailyUsed, input, output, this.requestLog.length);
    }
  }

  /**
   * A budget of zero (or less) is not a ceiling, it is the absence of one.
   *
   * The console has always read `dailyBudget: 0` as "unlimited", and an owner who clears the
   * field in the app means the same thing. Comparing `used >= 0` instead turned that request
   * into "every turn is refused from the first token" — a config that reads as *no limit* and
   * behaves as *no answers*, with nothing in the UI able to tell the two apart.
   */
  private hasCeiling(): boolean {
    return safeNumber(this.dailyBudget) > 0;
  }

  canAfford(estimatedTokens: number): boolean {
    this.resetIfNewDay();
    if (!this.hasCeiling()) return true;
    return safeNumber(this.dailyUsed) + estimatedTokens <= safeNumber(this.dailyBudget);
  }

  isOverBudget(): boolean {
    this.resetIfNewDay();
    if (this.forceNext) {
      this.forceNext = false;
      return false;
    }
    if (!this.hasCeiling()) return false;
    return safeNumber(this.dailyUsed) >= safeNumber(this.dailyBudget);
  }

  forceAllowNext(): void {
    this.forceNext = true;
    logger.info('Budget override: next request will proceed regardless of budget');
  }

  resetUsage(): void {
    this.dailyUsed = 0;
    this.dailySplit = emptySplit();
    this.requestLog = [];
    this.perAgentUsage.clear();
    this.persist();
    logger.info('Token usage reset to zero');
  }

  setBudget(newBudget: number): void {
    this.dailyBudget = newBudget;
    this.config.tokens.dailyBudget = newBudget;
    saveConfig(this.config);
    this.persist();
    logger.info({ newBudget }, 'Daily token budget updated');
  }

  getBudget(): number {
    return this.dailyBudget;
  }

  getDailyUsed(): number {
    this.resetIfNewDay();
    return this.dailyUsed;
  }

  recordUsage(entry: Omit<TokenLogEntry, 'timestamp'>): void {
    this.resetIfNewDay();
    const inputTokens = safeNumber(entry.inputTokens);
    const outputTokens = safeNumber(entry.outputTokens);
    const totalTokens = safeNumber(entry.totalTokens) || inputTokens + outputTokens;
    const hasSplit = entry.cachedInputTokens !== undefined;
    const cachedInputTokens = hasSplit ? Math.min(inputTokens, this.sanitizeCount(entry.cachedInputTokens)) : undefined;
    const noCacheInputTokens = hasSplit
      ? (entry.noCacheInputTokens !== undefined ? this.sanitizeCount(entry.noCacheInputTokens) : Math.max(0, inputTokens - (cachedInputTokens ?? 0)))
      : undefined;
    const countedTokens = countedTokensFor({ inputTokens, outputTokens, totalTokens, cachedInputTokens }, cachedWeightOf(this.config));
    const safeEntry = {
      ...entry,
      inputTokens,
      outputTokens,
      totalTokens,
      ...(hasSplit ? { cachedInputTokens, noCacheInputTokens } : {}),
      countedTokens,
    };
    const logEntry: TokenLogEntry = { ...safeEntry, timestamp: Date.now() };
    this.dailyUsed += countedTokens;
    this.dailySplit.inputTokens += inputTokens;
    this.dailySplit.outputTokens += outputTokens;
    if (hasSplit) {
      this.dailySplit.cachedInputTokens += cachedInputTokens ?? 0;
      this.dailySplit.noCacheInputTokens += noCacheInputTokens ?? 0;
    }
    this.requestLog.push(logEntry);
    // History keeps raw token counts; the weight only shapes the budget.
    recordDay(inputTokens, outputTokens, totalTokens, logEntry.timestamp);

    if (entry.agentId) {
      const agentUsed = this.perAgentUsage.get(entry.agentId) ?? 0;
      this.perAgentUsage.set(entry.agentId, agentUsed + countedTokens);
    }

    this.persist();
    this.syncToCloud(logEntry).catch((err) => {
      logger.warn({ err }, 'Failed to sync token usage to Mercury Cloud');
    });
  }

  private async syncToCloud(entry: TokenLogEntry): Promise<void> {
    if (!this.config.cloud.enabled || !this.config.cloud.jwt || !this.config.cloud.agentId || !this.config.cloud.apiUrl) return;
    if (entry.provider === 'mercuryCloud' || entry.provider === 'Mercury Cloud') return;
    if (entry.totalTokens <= 0) return;

    const res = await fetch(`${this.config.cloud.apiUrl}/v1/agents/${this.config.cloud.agentId}/usage/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.cloud.jwt}`,
      },
      body: JSON.stringify({
        model: `${entry.provider}:${entry.model}`,
        tokensIn: entry.inputTokens,
        tokensOut: entry.outputTokens,
        costCredits: 0,
        timestamp: new Date(entry.timestamp).toISOString(),
      }),
    });

    if (!res.ok) {
      throw new Error(`usage sync failed: ${res.status}`);
    }
  }

  getUsageByAgent(agentId: string): { used: number; percentage: number } {
    this.resetIfNewDay();
    const used = this.perAgentUsage.get(agentId) ?? 0;
    const budget = safeNumber(this.dailyBudget);
    return { used, percentage: budget > 0 ? (used / budget) * 100 : 0 };
  }

  getRemaining(): number {
    this.resetIfNewDay();
    return Math.max(0, safeNumber(this.dailyBudget) - safeNumber(this.dailyUsed));
  }

  getUsagePercentage(): number {
    this.resetIfNewDay();
    const budget = safeNumber(this.dailyBudget);
    const used = safeNumber(this.dailyUsed);
    return budget > 0 ? (used / budget) * 100 : 0;
  }

  getStatusText(): string {
    const used = this.sanitizeCount(this.dailyUsed);
    if (!this.hasCeiling()) {
      return `Token budget: ${formatNumber(used)} used today, no daily ceiling`;
    }
    const pct = Math.round(this.getUsagePercentage());
    const remaining = this.getRemaining();
    return `Token budget: ${formatNumber(used)} / ${formatNumber(this.dailyBudget)} used (${pct}%), ${formatNumber(remaining)} remaining`;
  }

  /** Today's cache split, for display. */
  getDailySplit(): DailySplit {
    this.resetIfNewDay();
    return { ...this.dailySplit };
  }

  /**
   * One line for /budget showing what the bar counts: input with its cache
   * hits and hit rate, uncached input, output, and the cache weight when it
   * is not 1. Empty when nothing was recorded today.
   */
  getCacheSplitText(): string {
    const s = this.getDailySplit();
    if (s.inputTokens <= 0 && s.outputTokens <= 0) return '';
    const weight = cachedWeightOf(this.config);
    const weightNote = weight !== 1 ? `, counted at ${weight}` : '';
    return `Today: ${formatNumber(s.inputTokens)} in (${formatNumber(s.cachedInputTokens)} cached · ${pct(s.cachedInputTokens, s.inputTokens)}%${weightNote}) · ${formatNumber(s.noCacheInputTokens)} uncached · ${formatNumber(s.outputTokens)} out`;
  }

  /**
   * Record an estimated savings from Token Saver Mode. Updates both the
   * per-day counter (resets at day rollover) and the lifetime counter
   * (persisted to mercury.yaml). Negative or zero values are ignored.
   */
  recordSavings(estimatedTokens: number): void {
    const n = safeNumber(estimatedTokens);
    if (n <= 0) return;
    this.resetIfNewDay();
    this.dailySaved += n;
    this.lifetimeSaved += n;
    try {
      (this.config.tokens as any).saverTokensSavedLifetime = this.lifetimeSaved;
      saveConfig(this.config);
    } catch (err) {
      logger.warn({ err }, 'Failed to persist saver lifetime counter');
    }
  }

  getSavedToday(): number {
    this.resetIfNewDay();
    return this.dailySaved;
  }

  getSavedLifetime(): number {
    return this.lifetimeSaved;
  }

  private resetIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.dailyUsed = 0;
      this.dailySplit = emptySplit();
      this.lastResetDate = today;
      this.requestLog = [];
      this.perAgentUsage.clear();
      this.dailySaved = 0;
      this.persist();
      logger.info('Token budget reset for new day');
    }
  }

  private persist(): void {
    const path = join(getMercuryHome(), TOKEN_FILE);
    try {
      const data = {
        dailyUsed: this.sanitizeCount(this.dailyUsed),
        dailyBudget: this.dailyBudget,
        lastResetDate: this.lastResetDate,
        requestLog: this.requestLog.slice(-200),
        dailySplit: this.dailySplit,
      };
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist token usage');
    }
  }

  private restore(): void {
    const path = join(getMercuryHome(), TOKEN_FILE);
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as Partial<TokenTracker>;
      const today = new Date().toISOString().split('T')[0];
      let repaired = false;
      const rawLogLength = Array.isArray(data.requestLog) ? data.requestLog.length : 0;
      const restoredLogs = Array.isArray(data.requestLog)
        ? data.requestLog
          .map((entry) => this.sanitizeLogEntry(entry as Omit<TokenLogEntry, 'timestamp'> & { timestamp?: unknown }, this.sanitizeTimestamp((entry as any)?.timestamp)))
          .filter((entry) => entry.totalTokens > 0)
        : [];
      if (restoredLogs.length !== rawLogLength) {
        repaired = true;
      }
      if (data.lastResetDate === today) {
        const restored = safeNumber(data.dailyUsed);
        if (data.dailyUsed != null && !isNaN(restored) && restored > 0) {
          this.dailyUsed = restored;
        } else {
          // Recompute from valid log entries when dailyUsed is corrupted/null
          this.dailyUsed = restoredLogs.reduce((sum, entry) => sum + (entry.countedTokens ?? entry.totalTokens), 0);
          repaired = true;
        }
        this.requestLog = (data.requestLog ?? []).map((entry: any) => ({
          ...entry,
          inputTokens: safeNumber(entry.inputTokens),
          outputTokens: safeNumber(entry.outputTokens),
          totalTokens: safeNumber(entry.totalTokens),
        }));
        const split = data.dailySplit;
        if (split && typeof split === 'object') {
          this.dailySplit = {
            inputTokens: this.sanitizeCount(split.inputTokens),
            cachedInputTokens: this.sanitizeCount(split.cachedInputTokens),
            noCacheInputTokens: this.sanitizeCount(split.noCacheInputTokens),
            outputTokens: this.sanitizeCount(split.outputTokens),
          };
        }
      }
      this.lastResetDate = data.lastResetDate ?? today;
      if (repaired) {
        this.persist();
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to restore token usage');
    }
  }

  private sanitizeCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private sanitizeTimestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  private sanitizeLogEntry(entry: Omit<TokenLogEntry, 'timestamp'> & { timestamp?: unknown }, timestamp: number): TokenLogEntry {
    const inputTokens = this.sanitizeCount(entry.inputTokens);
    const outputTokens = this.sanitizeCount(entry.outputTokens);
    const rawTotal = this.sanitizeCount(entry.totalTokens);
    const totalTokens = rawTotal > 0 ? rawTotal : inputTokens + outputTokens;

    const optional = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const cachedInputTokens = optional(entry.cachedInputTokens);
    const noCacheInputTokens = optional(entry.noCacheInputTokens);
    const countedTokens = optional(entry.countedTokens);

    return {
      timestamp: this.sanitizeTimestamp(timestamp),
      provider: typeof entry.provider === 'string' && entry.provider ? entry.provider : 'unknown',
      model: typeof entry.model === 'string' && entry.model ? entry.model : 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
      channelType: typeof entry.channelType === 'string' && entry.channelType ? entry.channelType : 'unknown',
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(noCacheInputTokens !== undefined ? { noCacheInputTokens } : {}),
      ...(countedTokens !== undefined ? { countedTokens } : {}),
    };
  }
}
