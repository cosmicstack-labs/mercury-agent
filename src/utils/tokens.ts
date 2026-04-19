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
    const logEntry: TokenLogEntry = { ...entry, timestamp: Date.now() };
    this.dailyUsed += entry.totalTokens;
    this.requestLog.push(logEntry);
    this.persist();
  }

  getRemaining(): number {
    this.resetIfNewDay();
    return Math.max(0, this.dailyBudget - this.dailyUsed);
  }

  getUsagePercentage(): number {
    this.resetIfNewDay();
    return this.dailyBudget > 0 ? (this.dailyUsed / this.dailyBudget) * 100 : 0;
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
        this.dailyUsed = data.dailyUsed ?? 0;
        this.requestLog = data.requestLog ?? [];
      }
      this.lastResetDate = data.lastResetDate ?? today;
    } catch (err) {
      logger.warn({ err }, 'Failed to restore token usage');
    }
  }
}