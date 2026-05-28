/**
 * Browser-Use Cloud cost tracker.
 *
 * Each Cloud session billable duration (session-seconds while status="running")
 * is converted to USD at the user's plan rate, accumulated per UTC day and
 * calendar month, and persisted to ~/.mercury/browser-use-usage.json.
 *
 * The router gates Cloud session creation on the configured budget ceilings
 * (browserUse.budgets.{dailyUsd,monthlyUsd}). When exhausted, new Cloud calls
 * are refused and Mercury falls back to the Local backend (or returns a
 * clear error if Local isn't installed).
 *
 * Mirrors the design of TokenBudget so behavior and persistence are familiar.
 *
 * Rate sources (USD/hour):
 *   - PAYG:     $0.06
 *   - Business: $0.03
 *   - Custom:   user-overridable via config.browserUse.budgets.hourlyRateUsd
 *
 * If hourlyRateUsd is 0 (default), we use $0.06 — the conservative public rate.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from './config.js';
import type { MercuryConfig } from './config.js';
import { logger } from './logger.js';

const USAGE_FILE = 'browser-use-usage.json';
const DEFAULT_HOURLY_RATE_USD = 0.06;

export interface BrowserUseSessionRecord {
  timestamp: number;
  sessionId: string;
  durationSec: number;
  costUsd: number;
  /** 'agent' for runAgentTask, 'browser' for CDP-driven sessions. */
  kind: 'agent' | 'browser';
}

export interface BrowserUseUsageSnapshot {
  dailyUsd: number;
  monthlyUsd: number;
  lastDailyResetDate: string;   // YYYY-MM-DD
  lastMonthlyResetMonth: string; // YYYY-MM
  sessionLog: BrowserUseSessionRecord[];
}

function safeNumber(value: unknown): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function todayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function thisMonthUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

export class BrowserUseUsageTracker {
  private dailyUsd = 0;
  private monthlyUsd = 0;
  private lastDailyResetDate = todayUtc();
  private lastMonthlyResetMonth = thisMonthUtc();
  private sessionLog: BrowserUseSessionRecord[] = [];

  constructor(private readonly cfg: MercuryConfig) {
    this.restore();
  }

  /** Hourly USD rate used to convert session seconds to cost. */
  private hourlyRate(): number {
    const rate = safeNumber(this.cfg.browserUse?.budgets?.hourlyRateUsd);
    return rate > 0 ? rate : DEFAULT_HOURLY_RATE_USD;
  }

  /** Daily ceiling (0 = unlimited). */
  dailyCeiling(): number {
    return safeNumber(this.cfg.browserUse?.budgets?.dailyUsd);
  }

  /** Monthly ceiling (0 = unlimited). */
  monthlyCeiling(): number {
    return safeNumber(this.cfg.browserUse?.budgets?.monthlyUsd);
  }

  /**
   * Returns 'ok' or a human-readable reason why a new Cloud session is denied.
   * Call BEFORE opening a Cloud session.
   */
  canStartCloudSession(): { ok: true } | { ok: false; reason: string } {
    this.rollIfNeeded();
    const day = this.dailyCeiling();
    if (day > 0 && this.dailyUsd >= day) {
      return { ok: false, reason: `Daily Browser-Use Cloud budget exhausted ($${this.dailyUsd.toFixed(4)} / $${day})` };
    }
    const month = this.monthlyCeiling();
    if (month > 0 && this.monthlyUsd >= month) {
      return { ok: false, reason: `Monthly Browser-Use Cloud budget exhausted ($${this.monthlyUsd.toFixed(4)} / $${month})` };
    }
    return { ok: true };
  }

  /**
   * Record that a Cloud session ran for `durationSec` seconds. Computes cost
   * and persists. Safe to call for sessions of 0 seconds (no-op).
   */
  recordSession(opts: { sessionId: string; durationSec: number; kind?: 'agent' | 'browser' }): void {
    this.rollIfNeeded();
    const seconds = Math.max(0, safeNumber(opts.durationSec));
    if (seconds === 0) return;
    const costUsd = (seconds / 3600) * this.hourlyRate();
    this.dailyUsd += costUsd;
    this.monthlyUsd += costUsd;
    this.sessionLog.push({
      timestamp: Date.now(),
      sessionId: opts.sessionId,
      durationSec: seconds,
      costUsd,
      kind: opts.kind ?? 'browser',
    });
    this.persist();
    logger.info({
      sessionId: opts.sessionId,
      durationSec: seconds,
      costUsd: costUsd.toFixed(4),
      dailyUsd: this.dailyUsd.toFixed(4),
      monthlyUsd: this.monthlyUsd.toFixed(4),
    }, 'Browser-Use Cloud session recorded');
  }

  getDailyUsd(): number {
    this.rollIfNeeded();
    return this.dailyUsd;
  }

  getMonthlyUsd(): number {
    this.rollIfNeeded();
    return this.monthlyUsd;
  }

  getStatusText(): string {
    this.rollIfNeeded();
    const day = this.dailyCeiling();
    const month = this.monthlyCeiling();
    const dayPart = day > 0
      ? `$${this.dailyUsd.toFixed(2)} / $${day.toFixed(2)} today`
      : `$${this.dailyUsd.toFixed(2)} today (no cap)`;
    const monthPart = month > 0
      ? `$${this.monthlyUsd.toFixed(2)} / $${month.toFixed(2)} this month`
      : `$${this.monthlyUsd.toFixed(2)} this month (no cap)`;
    return `Browser-Use Cloud: ${dayPart}, ${monthPart}`;
  }

  resetUsage(): void {
    this.dailyUsd = 0;
    this.monthlyUsd = 0;
    this.sessionLog = [];
    this.persist();
    logger.info('Browser-Use Cloud usage counters reset');
  }

  private rollIfNeeded(): void {
    const today = todayUtc();
    const month = thisMonthUtc();
    let changed = false;
    if (today !== this.lastDailyResetDate) {
      this.dailyUsd = 0;
      this.lastDailyResetDate = today;
      changed = true;
    }
    if (month !== this.lastMonthlyResetMonth) {
      this.monthlyUsd = 0;
      this.lastMonthlyResetMonth = month;
      this.sessionLog = []; // monthly cycle clears history
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const path = join(getMercuryHome(), USAGE_FILE);
    try {
      const data: BrowserUseUsageSnapshot = {
        dailyUsd: this.dailyUsd,
        monthlyUsd: this.monthlyUsd,
        lastDailyResetDate: this.lastDailyResetDate,
        lastMonthlyResetMonth: this.lastMonthlyResetMonth,
        sessionLog: this.sessionLog.slice(-500),
      };
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist Browser-Use Cloud usage');
    }
  }

  private restore(): void {
    const path = join(getMercuryHome(), USAGE_FILE);
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as Partial<BrowserUseUsageSnapshot>;
      this.lastDailyResetDate = typeof data.lastDailyResetDate === 'string' ? data.lastDailyResetDate : todayUtc();
      this.lastMonthlyResetMonth = typeof data.lastMonthlyResetMonth === 'string' ? data.lastMonthlyResetMonth : thisMonthUtc();
      this.dailyUsd = safeNumber(data.dailyUsd);
      this.monthlyUsd = safeNumber(data.monthlyUsd);
      this.sessionLog = Array.isArray(data.sessionLog)
        ? data.sessionLog
            .filter((e): e is BrowserUseSessionRecord => !!e && typeof e === 'object')
            .map((e): BrowserUseSessionRecord => ({
              timestamp: safeNumber(e.timestamp),
              sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
              durationSec: safeNumber(e.durationSec),
              costUsd: safeNumber(e.costUsd),
              kind: e.kind === 'agent' ? 'agent' : 'browser',
            }))
            .filter((e) => e.sessionId && e.durationSec > 0)
        : [];
      this.rollIfNeeded();
    } catch (err) {
      logger.warn({ err }, 'Failed to restore Browser-Use Cloud usage');
    }
  }
}

let singleton: BrowserUseUsageTracker | null = null;

export function getBrowserUseUsageTracker(cfg: MercuryConfig): BrowserUseUsageTracker {
  if (!singleton) singleton = new BrowserUseUsageTracker(cfg);
  return singleton;
}

/** Test-only: reset the singleton between tests. Not exported through index. */
export function __resetBrowserUseUsageTrackerForTests(): void {
  singleton = null;
}
