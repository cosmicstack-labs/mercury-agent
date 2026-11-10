import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { ChannelMessage } from '../types/channel.js';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { EVENT_ID_PATTERN, EVENT_DELIVERY_PATTERN, EVENT_PENDING_LIMIT, EVENT_RECEIPT_LIMIT, EVENT_RECEIPT_TTL_MS, EventTriggerError, eventWorkKey, isEventTriggerMessage } from './event-triggers.js';

const channelMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelType: z.enum(['cli', 'telegram', 'web', 'internal', 'signal', 'discord', 'slack', 'whatsapp', 'desktop']),
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
  status: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
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

const eventReceiptSchema = z.object({
  key: z.string(),
  triggerId: z.string().regex(EVENT_ID_PATTERN),
  deliveryId: z.string().regex(EVENT_DELIVERY_PATTERN),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  acceptedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  expiresAt: z.number().finite(),
});
export type EventReceipt = z.infer<typeof eventReceiptSchema>;

const ledgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(workEntrySchema),
  eventReceipts: z.array(eventReceiptSchema).default([]),
  eventIngressBlocked: z.boolean().default(false),
});

export type WorkStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WorkEntry = z.infer<typeof workEntrySchema>;

export interface WorkLedgerOptions {
  filePath?: string;
  maxTerminalEntries?: number;
  terminalMaxAgeMs?: number;
  now?: () => number;
  maxEventReceipts?: number;
  maxPendingEvents?: number;
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
  if (isEventTriggerMessage(message)) return eventWorkKey(message.metadata!.eventTriggerId as string, message.metadata!.eventDeliveryId as string);
  const requestId = message.metadata?.requestId;
  if (typeof requestId === 'string' && requestId.trim()) return `request:${requestId}`;
  const canonicalMessageId = message.metadata?.canonicalMessageId;
  if (typeof canonicalMessageId === 'string' && canonicalMessageId.trim()) return `canonical:${canonicalMessageId}`;
  return `channel:${message.channelType}:${message.id}`;
}

export class WorkLedger {
  private entries = new Map<string, WorkEntry>();
  private eventReceipts = new Map<string, EventReceipt>();
  private eventIngressBlocked = false;
  private readonly maxEventReceipts: number;
  private readonly maxPendingEvents: number;
  private readonly filePath: string;
  private readonly maxTerminalEntries: number;
  private readonly terminalMaxAgeMs: number;
  private readonly now: () => number;

  constructor(options: WorkLedgerOptions = {}) {
    this.filePath = options.filePath ?? join(getMercuryHome(), 'work-ledger.json');
    this.maxTerminalEntries = options.maxTerminalEntries ?? DEFAULT_MAX_TERMINAL_ENTRIES;
    this.terminalMaxAgeMs = options.terminalMaxAgeMs ?? DEFAULT_TERMINAL_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.maxEventReceipts = options.maxEventReceipts ?? EVENT_RECEIPT_LIMIT;
    this.maxPendingEvents = options.maxPendingEvents ?? EVENT_PENDING_LIMIT;
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
    try { this.persist(); } catch (error) { this.entries.delete(key); throw error; }
    return { accepted: true, entry: structuredClone(entry) };
  }

  /** Receipt and queued work are persisted in one atomic write before acknowledgement. */
  acceptEvent(message: ChannelMessage): { accepted: boolean; receipt: EventReceipt; entry?: WorkEntry } {
    if (this.eventIngressBlocked) throw new EventTriggerError('ledger_review_required', 503, 'Event acceptance is blocked until the damaged work ledger is reviewed.');
    if (!isEventTriggerMessage(message)) throw new Error('Missing event identity');
    const key = getWorkKey(message);
    this.pruneEventReceipts();
    const previous = this.eventReceipts.get(key);
    const hash = message.metadata?.eventPayloadHash;
    if (previous) {
      if (previous.payloadHash !== hash) throw new EventTriggerError('delivery_conflict', 409, 'This delivery id was already used with a different payload.');
      return { accepted: false, receipt: structuredClone(previous), entry: this.get(key) };
    }
    const existing = this.entries.get(key);
    if (existing && existing.message.metadata?.eventPayloadHash !== hash) throw new EventTriggerError('delivery_conflict', 409, 'This delivery id was already used with a different payload.');
    if (this.eventReceipts.size >= this.maxEventReceipts) throw new EventTriggerError('receipt_capacity', 429, 'Receipt capacity reached; no work was accepted.');
    const pending = [...this.entries.values()].filter((entry) => isEventTriggerMessage(entry.message) && (entry.status === 'queued' || entry.status === 'running' || entry.status === 'paused' || (entry.status === 'completed' && !entry.delivered))).length;
    if (pending >= this.maxPendingEvents) throw new EventTriggerError('event_queue_full', 429, 'Event queue is full; no work was accepted.');
    const now = this.now();
    const receipt = eventReceiptSchema.parse({
      key, triggerId: message.metadata!.eventTriggerId, deliveryId: message.metadata!.eventDeliveryId,
      payloadHash: hash, status: 'queued', acceptedAt: now, updatedAt: now, expiresAt: now + EVENT_RECEIPT_TTL_MS,
    });
    this.eventReceipts.set(key, receipt);
    try {
      const accepted = this.accept(message);
      // An unresolved work entry may outlive receipt retention. Never re-dispatch it.
      if (!accepted.accepted) {
        receipt.status = accepted.entry.status;
        receipt.updatedAt = accepted.entry.updatedAt;
        this.persist();
      }
      return { accepted: accepted.accepted, receipt: structuredClone(receipt), entry: accepted.entry };
    } catch (error) {
      this.eventReceipts.delete(key);
      throw error;
    }
  }

  getEventReceipt(triggerId: string, deliveryId: string): EventReceipt | undefined {
    const receipt = this.eventReceipts.get(eventWorkKey(triggerId, deliveryId));
    return receipt ? structuredClone(receipt) : undefined;
  }

  get(key: string): WorkEntry | undefined {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  markRunning(key: string): WorkEntry {
    return this.update(key, (entry) => {
      if (entry.status === 'cancelled') return;
      entry.status = 'running';
      entry.attempts += 1;
      entry.startedAt = this.now();
      entry.error = undefined;
      entry.nextAttemptAt = undefined;
    });
  }

  markCompleted(key: string, finalResponse: string): WorkEntry {
    return this.update(key, (entry) => {
      // A user-cancelled entry is terminal — do not resurrect it.
      if (entry.status === 'cancelled') return;
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
      if (entry.status === 'cancelled') return;
      entry.status = 'failed';
      entry.completedAt = this.now();
      entry.error = error instanceof Error ? error.message : String(error);
      entry.finalResponse = finalResponse ?? `I couldn't finish this request: ${entry.error}`;
      entry.delivered = false;
    });
  }

  /**
   * Pause an in-flight task honestly: the work is NOT done (step budget
   * exhausted, stall, interruption), so it must never read as completed.
   * Paused entries carry a resume hint and are recovered on restart like
   * interrupted work — a "continue" message (or a restart) resumes them.
   */
  markPaused(key: string, reason: string): WorkEntry {
    return this.update(key, (entry) => {
      if (entry.status === 'cancelled') return;
      entry.status = 'paused';
      entry.completedAt = this.now();
      entry.error = reason;
      entry.finalResponse = reason;
      entry.delivered = false;
    });
  }

  /**
   * Mark a single entry as cancelled by the user (terminal state).
   * Cancelled entries are NEVER auto-resumed by recoverInterrupted().
   */
  markCancelled(key: string, reason = 'Cancelled by the user'): WorkEntry {
    return this.update(key, (entry) => {
      entry.status = 'cancelled';
      entry.completedAt = this.now();
      entry.error = undefined;
      entry.nextAttemptAt = undefined;
      entry.finalResponse = isEventTriggerMessage(entry.message)
        ? 'Event work was cancelled. Inspect any partial effects before starting another delivery; this delivery will not run again.'
        : `This task was cancelled by the user before it completed. Nothing was lost — send "continue" if you want Mercury to resume it.`;
      entry.delivered = false;
      void reason;
    });
  }

  /**
   * Deliberate-shutdown sweep: every queued or running entry is marked
   * cancelled so a restart does NOT silently resume work the user chose
   * to stop. Called from /exit, SIGTERM/SIGINT shutdown, and the TUI
   * Ctrl+C exit path. Real crashes never reach this — their running
   * entries survive and recoverInterrupted() resumes them.
   */
  cancelActive(reason = 'Mercury was stopped by the user'): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status !== 'queued' && entry.status !== 'running') continue;
      this.markCancelled(entry.key, reason);
      count += 1;
    }
    if (count > 0) {
      logger.info({ count }, 'Deliberate shutdown: active work marked cancelled (no auto-resume)');
    }
    return count;
  }

  markRetry(key: string, error: unknown, nextAttemptAt: number, context: WorkContinuationContext = {}): WorkEntry {
    return this.update(key, (entry) => {
      if (isEventTriggerMessage(entry.message)) throw new Error('Event-triggered work is never automatically retried. Inspect its effects before starting another delivery.');
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
    const entriesBefore = structuredClone(this.entries);
    const receiptsBefore = structuredClone(this.eventReceipts);
    const recovered: WorkEntry[] = [];
    let changed = false;
    for (const entry of this.entries.values()) {
      const recoverableFailure = entry.status === 'failed' && /interrupted\/ambiguous|side effects may be partial|after one or more tools completed|partial output/i.test(entry.error || '');
      const isPaused = entry.status === 'paused';
      if (entry.status !== 'queued' && entry.status !== 'running' && !recoverableFailure && !isPaused) continue;
      if (typeof entry.message.metadata?.scheduledTaskId === 'string') {
        // The scheduler owns recovery. Never replay a turn whose external effects
        // may have happened before the process stopped, even if it was queued.
        this.markFailed(entry.key, 'Scheduled run interrupted; inspect its effects and explicitly reschedule it.');
        continue;
      }
      const interrupted = entry.status === 'running' || isPaused;
      if (isEventTriggerMessage(entry.message) && entry.status !== 'queued') {
        if (entry.status !== 'paused') {
          entry.status = 'paused';
          entry.updatedAt = this.now();
          entry.error = 'Event work was interrupted. Side effects may have happened; inspect them before starting another delivery.';
          entry.finalResponse = entry.error;
          entry.delivered = false;
          this.updateEventReceipt(entry);
          changed = true;
        }
        continue;
      }
      entry.status = 'queued';
      entry.updatedAt = this.now();
      entry.completedAt = undefined;
      entry.finalResponse = undefined;
      entry.delivered = false;
      entry.message.metadata = {
        ...entry.message.metadata,
        workRecovered: true,
        workWasInterrupted: interrupted || recoverableFailure,
        ...(recoverableFailure || isPaused ? {
          workContinuation: true,
          continuationAttempt: (typeof entry.message.metadata?.continuationAttempt === 'number' ? entry.message.metadata.continuationAttempt : 0) + 1,
          continuationReason: entry.error?.slice(0, 1000),
        } : {}),
      };
      recovered.push(structuredClone(entry));
    }
    if (recovered.length > 0 || changed) {
      try { this.persist(); } catch (error) {
        this.entries = entriesBefore;
        this.eventReceipts = receiptsBefore;
        throw error;
      }
    }
    return recovered;
  }

  /** Cancelled and paused entries carry a resume hint instead of a real response. */
  getUndeliveredResponses(): WorkEntry[] {
    return [...this.entries.values()]
      .filter((entry) => ((entry.status === 'completed' || entry.status === 'failed') && !entry.delivered && typeof entry.finalResponse === 'string')
        || ((entry.status === 'cancelled' || entry.status === 'paused') && !entry.delivered))
      .sort((a, b) => a.acceptedAt - b.acceptedAt)
      .map((entry) => structuredClone(entry));
  }

  private update(key: string, mutate: (entry: WorkEntry) => void): WorkEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Unknown work ledger entry: ${key}`);
    const before = structuredClone(entry);
    const receipt = this.eventReceipts.get(key);
    const receiptBefore = receipt ? structuredClone(receipt) : undefined;
    try {
      mutate(entry);
      entry.updatedAt = this.now();
      this.updateEventReceipt(entry);
      this.persist();
    } catch (error) {
      // A status response must never claim a terminal outcome that failed
      // to reach disk. The atomic rename is the persistence commit point.
      this.entries.set(key, before);
      if (receiptBefore) this.eventReceipts.set(key, receiptBefore);
      throw error;
    }
    return structuredClone(entry);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      // A previous process may have preserved corruption successfully, then
      // run out of disk space before writing the fence. Never mistake that
      // interrupted recovery for a first installation with no replay history.
      const dir = dirname(this.filePath);
      if (existsSync(dir) && readdirSync(dir).some((name) => name.startsWith(`${basename(this.filePath)}.corrupt-`))) {
        this.eventIngressBlocked = true;
        this.persist();
      }
      return;
    }
    try {
      const parsed = ledgerSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      this.entries = new Map(parsed.entries.map((entry) => [entry.key, entry]));
      this.eventReceipts = new Map(parsed.eventReceipts.map((receipt) => [receipt.key, receipt]));
      this.eventIngressBlocked = parsed.eventIngressBlocked;
      if (this.entries.size !== parsed.entries.length) throw new Error('Duplicate work identity');
      if (this.eventReceipts.size !== parsed.eventReceipts.length || this.eventReceipts.size > EVENT_RECEIPT_LIMIT) throw new Error('Invalid event receipt count');
      for (const receipt of this.eventReceipts.values()) {
        if (receipt.key !== eventWorkKey(receipt.triggerId, receipt.deliveryId)) throw new Error('Invalid event receipt identity');
        if (receipt.expiresAt < receipt.acceptedAt + EVENT_RECEIPT_TTL_MS) throw new Error('Invalid event receipt retention');
        const entry = this.entries.get(receipt.key);
        if (entry && (!isEventTriggerMessage(entry.message) || getWorkKey(entry.message) !== receipt.key || entry.message.metadata?.eventPayloadHash !== receipt.payloadHash || entry.status !== receipt.status)) throw new Error('Event receipt does not match durable work');
        if (!entry && ['queued', 'running', 'paused'].includes(receipt.status)) throw new Error('Missing unresolved event work');
      }
      for (const entry of this.entries.values()) {
        const receiptRequired = ['queued', 'running', 'paused'].includes(entry.status)
          || entry.acceptedAt + EVENT_RECEIPT_TTL_MS > this.now();
        if (isEventTriggerMessage(entry.message) && receiptRequired && !this.eventReceipts.has(entry.key)) throw new Error('Missing retained event receipt');
      }
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${this.now()}`;
      try {
        renameSync(this.filePath, recoveryPath);
      } catch (renameError) {
        logger.error({ renameError, filePath: this.filePath }, 'Unable to preserve invalid work ledger; stopping before overwrite');
        throw renameError;
      }
      this.entries.clear();
      this.eventReceipts.clear();
      // Persist the fence across restarts: losing dedupe evidence must never
      // silently make old signed events executable again.
      this.eventIngressBlocked = true;
      logger.error({ error, recoveryPath }, 'Invalid work ledger quarantined; starting with an empty ledger');
      this.persist();
    }
  }

  private persist(): void {
    // Pruning belongs to the same transaction as the write. A failed write
    // must retain unrelated entries as well as the caller's changed entry.
    const entriesBefore = this.entries;
    const receiptsBefore = this.eventReceipts;
    this.entries = new Map(this.entries);
    this.eventReceipts = new Map(this.eventReceipts);
    const tempPath = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let fd: number | undefined;
    try {
      this.prune();
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload = JSON.stringify({ version: 1, entries: [...this.entries.values()], eventReceipts: [...this.eventReceipts.values()], eventIngressBlocked: this.eventIngressBlocked }, null, 2) + '\n';
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
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.filePath);
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch {
        // Directory fsync is not supported on every platform/filesystem.
      } finally {
        if (dirFd !== undefined) {
          try { closeSync(dirFd); } catch { /* rename already committed */ }
        }
      }
    } catch (error) {
      this.entries = entriesBefore;
      this.eventReceipts = receiptsBefore;
      throw error;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
      try { unlinkSync(tempPath); } catch { /* best effort, including after commit */ }
    }
  }

  private updateEventReceipt(entry: WorkEntry): void {
    const receipt = this.eventReceipts.get(entry.key);
    if (receipt) { receipt.status = entry.status; receipt.updatedAt = entry.updatedAt; }
  }

  private pruneEventReceipts(): void {
    for (const [key, receipt] of this.eventReceipts) {
      const unresolved = receipt.status === 'queued' || receipt.status === 'running' || receipt.status === 'paused';
      if (!unresolved && receipt.expiresAt <= this.now()) this.eventReceipts.delete(key);
    }
  }

  private prune(): void {
    this.pruneEventReceipts();
    const terminal = [...this.entries.values()]
      .filter((entry) => entry.status === 'failed' || entry.status === 'cancelled' || (entry.status === 'completed' && entry.delivered))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const cutoff = this.now() - this.terminalMaxAgeMs;
    for (let index = 0; index < terminal.length; index++) {
      const entry = terminal[index];
      if (index >= this.maxTerminalEntries || entry.updatedAt < cutoff) this.entries.delete(entry.key);
    }
  }
}
