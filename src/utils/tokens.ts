import type { MercuryConfig } from './config.js';

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

export class TokenBudget {
  private dailyUsed = 0;
  private readonly dailyBudget: number;
  private lastResetDate: string;

  constructor(config: MercuryConfig) {
    this.dailyBudget = config.tokens.dailyBudget;
    this.lastResetDate = new Date().toISOString().split('T')[0];
  }

  canAfford(estimatedTokens: number): boolean {
    this.resetIfNewDay();
    return this.dailyUsed + estimatedTokens <= this.dailyBudget;
  }

  recordUsage(entry: Omit<TokenLogEntry, 'timestamp'>): void {
    this.resetIfNewDay();
    this.dailyUsed += entry.totalTokens;
  }

  getRemaining(): number {
    this.resetIfNewDay();
    return Math.max(0, this.dailyBudget - this.dailyUsed);
  }

  getUsagePercentage(): number {
    this.resetIfNewDay();
    return this.dailyBudget > 0 ? (this.dailyUsed / this.dailyBudget) * 100 : 0;
  }

  private resetIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.dailyUsed = 0;
      this.lastResetDate = today;
    }
  }
}