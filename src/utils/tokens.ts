import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MercuryConfig } from './config.js';
import { getMercuryHome, saveConfig } from './config.js';
import { logger } from './logger.js';

export interface TokenTracker {
  dailyUsed: number;
  dailyBudget: number;
  lastResetDate: string;
  requestLog: TokenLogEntry[];
}

export interface TokenLogEntry {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  channelType: string;
}

const TOKEN_FILE = 'token-usage.json';

export class TokenBudget {
  private dailyUsed = 0;
  private dailyBudget: number;
  private lastResetDate: string;
  private requestLog: TokenLogEntry[] = [];
  private forceNext = false;

  constructor(private config: MercuryConfig) {
    this.dailyBudget = config.tokens.dailyBudget;
    this.lastResetDate = new Date().toISOString().split('T')[0];
    this.restore();
  }

  canAfford(estimatedTokens: number): boolean {
    this.resetIfNewDay();
    return this.dailyUsed + estimatedTokens <= this.dailyBudget;
  }

  isOverBudget(): boolean {
    this.resetIfNewDay();
    if (this.forceNext) {
      this.forceNext = false;
      return false;
    }
    return this.dailyUsed >= this.dailyBudget;
  }

  forceAllowNext(): void {
    this.forceNext = true;
    logger.info('Budget override: next request will proceed regardless of budget');
  }

  resetUsage(): void {
    this.dailyUsed = 0;
    this.requestLog = [];
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
    const logEntry = this.sanitizeLogEntry(entry, Date.now());
    this.dailyUsed = this.sanitizeCount(this.dailyUsed) + logEntry.totalTokens;
    this.requestLog.push(logEntry);
    this.persist();
  }

  getRemaining(): number {
    this.resetIfNewDay();
    const used = this.sanitizeCount(this.dailyUsed);
    return Math.max(0, this.dailyBudget - used);
  }

  getUsagePercentage(): number {
    this.resetIfNewDay();
    const used = this.sanitizeCount(this.dailyUsed);
    return this.dailyBudget > 0 ? (used / this.dailyBudget) * 100 : 0;
  }

  getStatusText(): string {
    const used = this.sanitizeCount(this.dailyUsed);
    const pct = Math.round(this.getUsagePercentage());
    const remaining = this.getRemaining();
    return `Token budget: ${used.toLocaleString()} / ${this.dailyBudget.toLocaleString()} used (${pct}%), ${remaining.toLocaleString()} remaining`;
  }

  private resetIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.dailyUsed = 0;
      this.lastResetDate = today;
      this.requestLog = [];
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
        const restoredDaily = this.sanitizeCount(data.dailyUsed);
        const sumFromLog = restoredLogs.reduce((sum, row) => sum + row.totalTokens, 0);
        this.dailyUsed = restoredDaily > 0 ? restoredDaily : sumFromLog;
        this.requestLog = restoredLogs;
        if (restoredDaily !== this.sanitizeCount(data.dailyUsed)) {
          repaired = true;
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

    return {
      timestamp: this.sanitizeTimestamp(timestamp),
      provider: typeof entry.provider === 'string' && entry.provider ? entry.provider : 'unknown',
      model: typeof entry.model === 'string' && entry.model ? entry.model : 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
      channelType: typeof entry.channelType === 'string' && entry.channelType ? entry.channelType : 'unknown',
    };
  }
}