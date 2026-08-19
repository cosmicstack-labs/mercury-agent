import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ChannelMessage } from '../types/channel.js';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const channelMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelType: z.enum(['cli', 'telegram', 'web', 'internal', 'signal', 'discord', 'slack', 'whatsapp']),
  senderId: z.string(),
  senderName: z.string().optional(),
  content: z.string(),
  timestamp: z.number().finite(),
  sessionId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const workEntrySchema = z.object({
  key: z.string(),
  message: channelMessageSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  attempts: z.number().int().nonnegative(),
  acceptedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  completedAt: z.number().finite().optional(),
  finalResponse: z.string().optional(),
  error: z.string().optional(),
  delivered: z.boolean(),
  deliveryError: z.string().optional(),
  nextAttemptAt: z.number().finite().optional(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(workEntrySchema),
});

export type WorkStatus = 'queued' | 'running' | 'completed' | 'failed';
export type WorkEntry = z.infer<typeof workEntrySchema>;

export interface WorkLedgerOptions {
  filePath?: string;
  maxTerminalEntries?: number;
  terminalMaxAgeMs?: number;
  now?: () => number;
}

export interface WorkContinuationContext {
  workCwd?: string;
  activity?: string;
  summary?: string;
  continuation?: boolean;
}

const DEFAULT_MAX_TERMINAL_ENTRIES = 500;
const DEFAULT_TERMINAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getWorkKey(message: ChannelMessage): string {
  const requestId = message.metadata?.requestId;
  if (typeof requestId === 'string' && requestId.trim()) return `request:${requestId}`;
  const canonicalMessageId = message.metadata?.canonicalMessageId;
  if (typeof canonicalMessageId === 'string' && canonicalMessageId.trim()) return `canonical:${canonicalMessageId}`;
  return `channel:${message.channelType}:${message.id}`;
}

export class WorkLedger {
  private entries = new Map<string, WorkEntry>();
  private readonly filePath: string;
  private readonly maxTerminalEntries: number;
  private readonly terminalMaxAgeMs: number;
  private readonly now: () => number;

  constructor(options: WorkLedgerOptions = {}) {
    this.filePath = options.filePath ?? join(getMercuryHome(), 'work-ledger.json');
    this.maxTerminalEntries = options.maxTerminalEntries ?? DEFAULT_MAX_TERMINAL_ENTRIES;
    this.terminalMaxAgeMs = options.terminalMaxAgeMs ?? DEFAULT_TERMINAL_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.load();
  }

  accept(message: ChannelMessage): { accepted: boolean; entry: WorkEntry } {
    const key = getWorkKey(message);
    const existing = this.entries.get(key);
    if (existing) return { accepted: false, entry: structuredClone(existing) };

    const now = this.now();
    const entry: WorkEntry = {
      key,
      message: channelMessageSchema.parse(JSON.parse(JSON.stringify(message))),
      status: 'queued',
      attempts: 0,
      acceptedAt: now,
      updatedAt: now,
      delivered: false,
    };
    this.entries.set(key, entry);
    this.persist();
    return { accepted: true, entry: structuredClone(entry) };
  }

  get(key: string): WorkEntry | undefined {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  markRunning(key: string): WorkEntry {
    return this.update(key, (entry) => {
      entry.status = 'running';
      entry.attempts += 1;
      entry.startedAt = this.now();
      entry.error = undefined;
      entry.nextAttemptAt = undefined;
    });
  }

  markCompleted(key: string, finalResponse: string): WorkEntry {
    return this.update(key, (entry) => {
      entry.status = 'completed';
      entry.completedAt = this.now();
      entry.finalResponse = finalResponse;
      entry.error = undefined;
      entry.delivered = false;
      entry.deliveryError = undefined;
    });
  }

  markFailed(key: string, error: unknown, finalResponse?: string): WorkEntry {
    return this.update(key, (entry) => {
      entry.status = 'failed';
      entry.completedAt = this.now();
      entry.error = error instanceof Error ? error.message : String(error);
      entry.finalResponse = finalResponse ?? `I couldn't finish this request: ${entry.error}`;
      entry.delivered = false;
    });
  }

  markRetry(key: string, error: unknown, nextAttemptAt: number, context: WorkContinuationContext = {}): WorkEntry {
    return this.update(key, (entry) => {
      entry.status = 'queued';
      entry.error = error instanceof Error ? error.message : String(error);
      entry.nextAttemptAt = nextAttemptAt;
      entry.delivered = false;
      entry.completedAt = undefined;
      entry.finalResponse = undefined;
      entry.deliveryError = undefined;
      const previousContinuationAttempt = typeof entry.message.metadata?.continuationAttempt === 'number'
        ? entry.message.metadata.continuationAttempt
        : 0;
      entry.message.metadata = {
        ...entry.message.metadata,
        workRecovered: true,
        workWasInterrupted: true,
        ...(context.continuation ? { workContinuation: true, continuationAttempt: previousContinuationAttempt + 1 } : {}),
        ...(context.workCwd ? { workCwd: context.workCwd } : {}),
        ...(context.activity ? { continuationActivity: context.activity.slice(0, 300) } : {}),
        ...(context.summary ? { continuationSummary: context.summary.slice(0, 1000) } : {}),
        continuationReason: entry.error.slice(0, 1000),
      };
    });
  }

  markDelivered(key: string): WorkEntry {
    return this.update(key, (entry) => {
      entry.delivered = true;
      entry.deliveryError = undefined;
    });
  }

  markDeliveryError(key: string, error: unknown): WorkEntry {
    return this.update(key, (entry) => {
      entry.delivered = false;
      entry.deliveryError = error instanceof Error ? error.message : String(error);
    });
  }

  recoverInterrupted(): WorkEntry[] {
    const recovered: WorkEntry[] = [];
    for (const entry of this.entries.values()) {
      const recoverableFailure = entry.status === 'failed' && /interrupted\/ambiguous|side effects may be partial|after one or more tools completed|partial output/i.test(entry.error || '');
      if (entry.status !== 'queued' && entry.status !== 'running' && !recoverableFailure) continue;
      const interrupted = entry.status === 'running';
      entry.status = 'queued';
      entry.updatedAt = this.now();
      entry.completedAt = undefined;
      entry.finalResponse = undefined;
      entry.delivered = false;
      entry.message.metadata = {
        ...entry.message.metadata,
        workRecovered: true,
        workWasInterrupted: interrupted || recoverableFailure,
        ...(recoverableFailure ? {
          workContinuation: true,
          continuationAttempt: (typeof entry.message.metadata?.continuationAttempt === 'number' ? entry.message.metadata.continuationAttempt : 0) + 1,
          continuationReason: entry.error?.slice(0, 1000),
        } : {}),
      };
      recovered.push(structuredClone(entry));
    }
    if (recovered.length > 0) this.persist();
    return recovered;
  }

  getUndeliveredResponses(): WorkEntry[] {
    return [...this.entries.values()]
      .filter((entry) => (entry.status === 'completed' || entry.status === 'failed') && !entry.delivered && typeof entry.finalResponse === 'string')
      .sort((a, b) => a.acceptedAt - b.acceptedAt)
      .map((entry) => structuredClone(entry));
  }

  private update(key: string, mutate: (entry: WorkEntry) => void): WorkEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Unknown work ledger entry: ${key}`);
    mutate(entry);
    entry.updatedAt = this.now();
    this.persist();
    return structuredClone(entry);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = ledgerSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      this.entries = new Map(parsed.entries.map((entry) => [entry.key, entry]));
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${this.now()}`;
      try {
        renameSync(this.filePath, recoveryPath);
      } catch (renameError) {
        logger.warn({ renameError, filePath: this.filePath }, 'Unable to quarantine invalid work ledger');
      }
      this.entries.clear();
      logger.error({ error, recoveryPath }, 'Invalid work ledger quarantined; starting with an empty ledger');
      this.persist();
    }
  }

  private persist(): void {
    this.prune();
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const payload = JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2) + '\n';
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      const buffer = Buffer.from(payload);
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        offset += written;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.filePath);
      chmodSync(this.filePath, 0o600);
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch {
        // Directory fsync is not supported on every platform/filesystem.
      } finally {
        if (dirFd !== undefined) closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch { /* best effort */ }
      }
    }
  }

  private prune(): void {
    const terminal = [...this.entries.values()]
      .filter((entry) => entry.status === 'failed' || (entry.status === 'completed' && entry.delivered))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const cutoff = this.now() - this.terminalMaxAgeMs;
    for (let index = 0; index < terminal.length; index++) {
      const entry = terminal[index];
      if (index >= this.maxTerminalEntries || entry.updatedAt < cutoff) this.entries.delete(entry.key);
    }
  }
}
