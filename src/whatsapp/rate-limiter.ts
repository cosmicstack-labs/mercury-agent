import { logger } from '../utils/logger.js';

interface RateLimitEntry {
  timestamps: number[];
}

export class WhatsAppRateLimiter {
  private perChatHourly = new Map<string, number[]>();
  private globalHourly: number[] = [];
  private globalDaily: number[] = [];
  private lastSendTime = 0;

  private readonly MIN_SEND_INTERVAL_MS = 3000;
  private readonly PER_CHAT_HOURLY_LIMIT = 60;
  private readonly GLOBAL_HOURLY_LIMIT = 200;
  private readonly GLOBAL_DAILY_LIMIT = 1000;
  private readonly HOUR_MS = 3_600_000;
  private readonly DAY_MS = 86_400_000;

  private queue: Array<{ fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private processing = false;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (v: unknown) => void, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.waitIfRateLimited();
        const result = await item.fn();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.processing = false;
  }

  private async waitIfRateLimited(): Promise<void> {
    const now = Date.now();
    const minWait = this.MIN_SEND_INTERVAL_MS - (now - this.lastSendTime);
    if (minWait > 0) {
      const jitter = Math.random() * 2000;
      await this.sleep(minWait + jitter);
    }

    this.pruneTimestamps(now);
    this.lastSendTime = Date.now();
    this.globalHourly.push(this.lastSendTime);
    this.globalDaily.push(this.lastSendTime);
  }

  checkRateLimit(jid: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    this.pruneTimestamps(now);

    if (this.globalDaily.length >= this.GLOBAL_DAILY_LIMIT) {
      logger.warn({ dailyCount: this.globalDaily.length }, 'WhatsApp: daily rate limit reached');
      return { allowed: false, reason: 'Daily message limit reached (1000). Try again tomorrow.' };
    }

    if (this.globalHourly.length >= this.GLOBAL_HOURLY_LIMIT) {
      logger.warn({ hourlyCount: this.globalHourly.length }, 'WhatsApp: hourly rate limit reached');
      return { allowed: false, reason: 'Hourly message limit reached (200). Try again later.' };
    }

    const chatTimestamps = this.perChatHourly.get(jid) || [];
    if (chatTimestamps.length >= this.PER_CHAT_HOURLY_LIMIT) {
      logger.warn({ jid, chatCount: chatTimestamps.length }, 'WhatsApp: per-chat hourly rate limit reached');
      return { allowed: false, reason: 'Per-chat hourly limit reached (60). Try again later.' };
    }

    return { allowed: true };
  }

  recordSend(jid: string): void {
    const now = Date.now();
    const chatTimestamps = this.perChatHourly.get(jid) || [];
    chatTimestamps.push(now);
    this.perChatHourly.set(jid, chatTimestamps);
  }

  private pruneTimestamps(now: number): void {
    const hourAgo = now - this.HOUR_MS;
    const dayAgo = now - this.DAY_MS;

    this.globalHourly = this.globalHourly.filter(t => t > hourAgo);
    this.globalDaily = this.globalDaily.filter(t => t > dayAgo);

    for (const [jid, timestamps] of this.perChatHourly.entries()) {
      const pruned = timestamps.filter(t => t > hourAgo);
      if (pruned.length === 0) {
        this.perChatHourly.delete(jid);
      } else {
        this.perChatHourly.set(jid, pruned);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reset(): void {
    this.perChatHourly.clear();
    this.globalHourly = [];
    this.globalDaily = [];
    this.lastSendTime = 0;
  }

  getStats(): { hourlyGlobal: number; dailyGlobal: number; chatCount: number } {
    const now = Date.now();
    this.pruneTimestamps(now);
    return {
      hourlyGlobal: this.globalHourly.length,
      dailyGlobal: this.globalDaily.length,
      chatCount: this.perChatHourly.size,
    };
  }
}