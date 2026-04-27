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

function safeNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

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
    return safeNumber(this.dailyUsed) + estimatedTokens <= safeNumber(this.dailyBudget);
  }

  isOverBudget(): boolean {
    this.resetIfNewDay();
    if (this.forceNext) {
      this.forceNext = false;
      return false;
    }
    return safeNumber(this.dailyUsed) >= safeNumber(this.dailyBudget);
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
    const inputTokens = safeNumber(entry.inputTokens);
    const outputTokens = safeNumber(entry.outputTokens);
    const totalTokens = safeNumber(entry.totalTokens) || inputTokens + outputTokens;
    const safeEntry = { ...entry, inputTokens, outputTokens, totalTokens };
    const logEntry: TokenLogEntry = { ...safeEntry, timestamp: Date.now() };
    this.dailyUsed += totalTokens;
    this.requestLog.push(logEntry);
    this.persist();
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
    const pct = Math.round(this.getUsagePercentage());
    const remaining = this.getRemaining();
    return `Token budget: ${this.dailyUsed.toLocaleString()} / ${this.dailyBudget.toLocaleString()} used (${pct}%), ${remaining.toLocaleString()} remaining`;
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
        dailyUsed: this.dailyUsed,
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
      if (data.lastResetDate === today) {
        const restored = safeNumber(data.dailyUsed);
        if (!isNaN(restored)) {
          this.dailyUsed = restored;
        }
        this.requestLog = (data.requestLog ?? []).map((entry: any) => ({
          ...entry,
          inputTokens: safeNumber(entry.inputTokens),
          outputTokens: safeNumber(entry.outputTokens),
          totalTokens: safeNumber(entry.totalTokens),
        }));
      }
      this.lastResetDate = data.lastResetDate ?? today;
    } catch (err) {
      logger.warn({ err }, 'Failed to restore token usage');
    }
  }
}