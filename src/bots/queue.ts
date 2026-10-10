import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { isSqliteAvailable, openSqlite, type SqliteDatabase } from '../utils/sqlite-driver.js';
import type { BotTrigger } from './types.js';

export const QUEUE_DB_FILE = 'queue.db';

export interface DurableBotJob {
  id: string;
  botId: string;
  trigger: BotTrigger;
  prompt: string;
  fromBot?: string;
  source?: { channelType: string; channelId: string };
  state: 'pending' | 'claimed' | 'dead';
  attempts: number;
  createdAt: number;
  leaseExpiresAt?: number;
  idempotencyKey: string;
  reasonCode?: string;
  settledAt?: number;
  /** Earliest time the job may run again (transient-retry backoff). */
  runAfter?: number;
}

export interface DurableMail {
  id: string;
  botId: string;
  from: string;
  content: string;
  createdAt: number;
}

export interface DlqEntry extends DurableBotJob {
  deadAt: number;
}

export interface QueueCounts {
  pending: number;
  claimed: number;
  dlq: number;
}

export interface BotQueueBackend {
  readonly name: string;
  /** Returns the stored job (existing one when duplicated by idempotency key). */
  enqueue(job: Omit<DurableBotJob, 'state'>): { job: DurableBotJob; duplicated: boolean };
  claim(jobId: string, leaseSeconds: number): void;
  /** done → removed; dead → moved to the capped DLQ. */
  settle(jobId: string, outcome: 'done' | 'dead', reasonCode?: string): void;
  /**
   * Durable in-place retry for a claimed job: attempts+1, back to pending,
   * with an optional run-after timestamp. No settle-then-reenqueue window —
   * a crash at any point still leaves the job in the queue.
   */
  retry(jobId: string, attempts: number, runAfterMs?: number): void;
  /** Jobs safe to resume: pending (due), or claimed whose lease has expired. */
  rehydratable(): DurableBotJob[];
  /** Pending jobs whose run-after time has arrived (retry backoff elapsed). */
  dueJobs(): DurableBotJob[];
  /** All pending jobs for one bot, in creation order — explicit resume (/bots start), ignores retry backoff. */
  pendingJobs(botId: string): DurableBotJob[];
  /** Expired-lease claimed jobs → pending. Returns the count requeued. */
  requeueExpiredLeases(): number;
  heartbeatLease(jobId: string, leaseSeconds: number): void;
  listDlq(botId?: string): DlqEntry[];
  /** Read a DLQ entry without removing it (replay does lookup-then-remove so a bot mismatch never destroys the entry). */
  peekDlq(jobId: string): DurableBotJob | null;
  removeFromDlq(jobId: string): DurableBotJob | null;
  /** Drop every dead-lettered job (of one bot, or all). Returns the count removed. */
  clearDlq(botId?: string): number;
  /** Durable bot-to-bot mailbox (§2.6: a handoff must survive a crash). */
  enqueueMail(mail: Omit<DurableMail, 'id'>): string;
  drainMail(botId: string): DurableMail[];
  /** Remove every trace of a bot: jobs, mail, DLQ rows (delete lifecycle). */
  purgeBot(botId: string): void;
  counts(): QueueCounts;
  /**
   * Release native handles (the SQLite connection). Idempotent — a second
   * close is a no-op. On Windows an open handle keeps the file locked
   * (EBUSY on delete): teardown, fleet-delete cleanup, and shutdown must
   * close before any directory removal.
   */
  close(): void;
}

export const LEASE_SECONDS = 60;
const DLQ_CAP = 100;

export function idempotencyKeyFor(botId: string, trigger: BotTrigger, prompt: string, fromBot?: string): string {
  return createHash('sha256').update(`${botId}|${trigger}|${prompt}|${fromBot ?? ''}`).digest('hex').slice(0, 16);
}

function normalizeJob(raw: any): DurableBotJob {
  // SQLite rows use snake_case columns; JSON rows camelCase — map both.
  let source = raw.source;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = undefined; }
  }
  return {
    id: String(raw.id),
    botId: String(raw.botId ?? raw.bot_id),
    trigger: raw.trigger,
    prompt: raw.prompt ?? '',
    fromBot: raw.fromBot ?? raw.from_bot ?? undefined,
    source,
    state: raw.state ?? 'pending',
    attempts: raw.attempts ?? 0,
    createdAt: raw.createdAt ?? raw.created_at ?? Date.now(),
    leaseExpiresAt: raw.leaseExpiresAt ?? raw.lease_expires_at ?? undefined,
    idempotencyKey: raw.idempotencyKey ?? '',
    reasonCode: raw.reasonCode ?? raw.reason_code ?? undefined,
    settledAt: raw.settledAt ?? raw.settled_at ?? undefined,
  };
}

/**
 * Durable bot job queue — the "enqueue before ack" boundary
 * (BOTS-ARCHITECTURE.md §2.6). Backend chain: SQLite via the shared driver
 * (better-sqlite3 → bun:sqlite → node:sqlite, src/utils/sqlite-driver.ts)
 * → JSON-file lease store. Correctness never depends on SQLite: the queue is
 * single-writer (in-process BotManager), so durability (atomic rename +
 * fsync) and lease-expiry timestamp logic are all that is required.
 */
export class BotQueue {
  readonly backend: BotQueueBackend;
  /** Post-close guard: in-flight turns' queue access degrades to no-ops. */
  private closed = false;

  constructor(botsRoot: string, dlqCap: number = DLQ_CAP) {
    const path = resolve(botsRoot);
    if (isSqliteAvailable()) {
      this.backend = new SqliteQueueBackend(path, dlqCap);
    } else {
      this.backend = new JsonFileQueueBackend(path, dlqCap);
    }
    logger.info({ backend: this.backend.name, path }, 'Bot queue initialized');
  }

  /** Release native handles (the SQLite connection). Idempotent. */
  close(): void {
    this.closed = true;
    this.backend.close();
  }

  enqueue(job: Omit<DurableBotJob, 'state'>): { job: DurableBotJob; duplicated: boolean } {
    if (this.closed) return { job: { ...job, state: 'pending' } as DurableBotJob, duplicated: false };
    return this.backend.enqueue(job);
  }

  claim(jobId: string, leaseSeconds: number = LEASE_SECONDS): void {
    this.backend.claim(jobId, leaseSeconds);
  }

  settle(jobId: string, outcome: 'done' | 'dead', reasonCode?: string): void {
    if (this.closed) return;
    this.backend.settle(jobId, outcome, reasonCode);
  }

  /** Durable in-place retry: no settle-then-reenqueue window. */
  retry(jobId: string, attempts: number, runAfterMs?: number): void {
    if (this.closed) return;
    this.backend.retry(jobId, attempts, runAfterMs);
  }

  /** Jobs to resume on startup: due pending, plus expired-lease claimed jobs. */
  resumeJobs(): DurableBotJob[] {
    const expired = this.backend.requeueExpiredLeases();
    if (expired > 0) logger.info({ expired }, 'Requeued expired bot job leases');
    return this.backend.rehydratable();
  }

  /** Pending jobs whose retry backoff has elapsed (swept periodically). */
  dueJobs(): DurableBotJob[] {
    if (this.closed) return [];
    return this.backend.dueJobs();
  }

  /** All pending jobs for one bot — explicit resume via /bots start. */
  pendingJobs(botId: string): DurableBotJob[] {
    if (this.closed) return [];
    return this.backend.pendingJobs(botId);
  }

  enqueueMail(mail: Omit<DurableMail, 'id'>): string {
    if (this.closed) return '';
    return this.backend.enqueueMail(mail);
  }

  drainMail(botId: string): DurableMail[] {
    if (this.closed) return [];
    return this.backend.drainMail(botId);
  }

  purgeBot(botId: string): void {
    if (this.closed) return;
    this.backend.purgeBot(botId);
  }

  listDlq(botId?: string): DlqEntry[] {
    if (this.closed) return [];
    return this.backend.listDlq(botId);
  }

  removeFromDlq(jobId: string): DurableBotJob | null {
    if (this.closed) return null;
    return this.backend.removeFromDlq(jobId);
  }

  peekDlq(jobId: string): DurableBotJob | null {
    if (this.closed) return null;
    return this.backend.peekDlq(jobId);
  }

  clearDlq(botId?: string): number {
    if (this.closed) return 0;
    return this.backend.clearDlq(botId);
  }

  heartbeatLease(jobId: string, leaseSeconds: number = LEASE_SECONDS): void {
    if (this.closed) return;
    this.backend.heartbeatLease(jobId, leaseSeconds);
  }

  counts(): QueueCounts {
    if (this.closed) return { pending: 0, claimed: 0, dlq: 0 };
    return this.backend.counts();
  }
}

// ---------------------------------------------------------------------------
// SQLite backend (shared driver, WAL)
// ---------------------------------------------------------------------------

export class SqliteQueueBackend implements BotQueueBackend {
  /** The engine name (`better-sqlite3`, `bun:sqlite`, `node:sqlite`). */
  readonly name: string;
  private db: SqliteDatabase;
  private dlqCap: number;
  // A disposed manager must never turn an in-flight turn's queue access into
  // a crash: post-close ops degrade to no-ops (an unsettled claim survives
  // via lease expiry and resumes on the next boot).
  private closed = false;

  /** `db` lets tests hand in an already-open handle; otherwise `<path>/queue.db` is opened via the driver. */
  constructor(path: string, dlqCap: number, db?: SqliteDatabase) {
    mkdirSync(path, { recursive: true });
    const handle = db ?? openSqlite(join(path, QUEUE_DB_FILE));
    if (!handle) throw new Error('No SQLite engine available for the bot queue');
    this.db = handle;
    this.name = handle.backend;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_jobs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        prompt TEXT NOT NULL,
        from_bot TEXT,
        source TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        idempotency_key TEXT NOT NULL,
        reason_code TEXT,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bot_jobs_state ON bot_jobs (state, created_at);
      CREATE TABLE IF NOT EXISTS bot_mail (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        from_bot TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_mail_bot ON bot_mail (bot_id, created_at);
      CREATE TABLE IF NOT EXISTS bot_dlq (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        prompt TEXT NOT NULL,
        from_bot TEXT,
        source TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        reason_code TEXT,
        dead_at INTEGER NOT NULL
      );
    `);
    // Migration for queues created before run_after / bot_mail existed.
    try { this.db.exec('ALTER TABLE bot_jobs ADD COLUMN run_after INTEGER'); } catch { /* already present */ }
    this.dlqCap = dlqCap;
  }

  enqueue(job: Omit<DurableBotJob, 'state'>): { job: DurableBotJob; duplicated: boolean } {
    const dup = this.db.prepare(
      `SELECT * FROM bot_jobs WHERE bot_id = ? AND idempotency_key = ? AND state IN ('pending','claimed') LIMIT 1`,
    ).get(job.botId, job.idempotencyKey) as any;
    if (dup) {
      return { job: normalizeJob(dup), duplicated: true };
    }
    const stored: DurableBotJob = { ...job, state: 'pending' };
    this.db.prepare(
      `INSERT INTO bot_jobs (id, bot_id, trigger, prompt, from_bot, source, state, attempts, created_at, lease_expires_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      stored.id, stored.botId, stored.trigger, stored.prompt,
      stored.fromBot ?? null, stored.source ? JSON.stringify(stored.source) : null,
      stored.attempts, stored.createdAt, stored.leaseExpiresAt ?? null, stored.idempotencyKey,
    );
    return { job: stored, duplicated: false };
  }

  claim(jobId: string, leaseSeconds: number): void {
    if (this.closed) return;
    this.db.prepare(`UPDATE bot_jobs SET state = 'claimed', lease_expires_at = ? WHERE id = ?`)
      .run(Date.now() + leaseSeconds * 1000, jobId);
  }

  heartbeatLease(jobId: string, leaseSeconds: number): void {
    if (this.closed) return;
    this.db.prepare(`UPDATE bot_jobs SET lease_expires_at = ? WHERE id = ? AND state = 'claimed'`)
      .run(Date.now() + leaseSeconds * 1000, jobId);
  }

  settle(jobId: string, outcome: 'done' | 'dead', reasonCode?: string): void {
    const row = this.db.prepare(`SELECT * FROM bot_jobs WHERE id = ?`).get(jobId) as any;
    if (!row) return;
    if (outcome === 'done') {
      this.db.prepare(`DELETE FROM bot_jobs WHERE id = ?`).run(jobId);
      return;
    }
    this.db.prepare(`DELETE FROM bot_jobs WHERE id = ?`).run(jobId);
    this.db.prepare(
      `INSERT INTO bot_dlq (id, bot_id, trigger, prompt, from_bot, source, attempts, created_at, idempotency_key, reason_code, dead_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.bot_id, row.trigger, row.prompt, row.from_bot, row.source,
      row.attempts + 1, row.created_at, row.idempotency_key, reasonCode ?? row.reason_code ?? null, Date.now(),
    );
    // Cap the DLQ — evict oldest, bounded by design (§2.10).
    const overflow = this.db.prepare(
      `SELECT id FROM bot_dlq ORDER BY dead_at DESC, created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
    ).all(this.dlqCap) as any[];
    for (const r of overflow) {
      this.db.prepare(`DELETE FROM bot_dlq WHERE id = ?`).run(r.id);
    }
  }

  requeueExpiredLeases(): number {
    if (this.closed) return 0;
    const result = this.db.prepare(
      `UPDATE bot_jobs SET state = 'pending', lease_expires_at = NULL WHERE state = 'claimed' AND lease_expires_at <= ?`,
    ).run(Date.now());
    return result.changes as number;
  }

  retry(jobId: string, attempts: number, runAfterMs?: number): void {
    this.db.prepare(
      `UPDATE bot_jobs SET state = 'pending', attempts = ?, lease_expires_at = NULL, run_after = ? WHERE id = ?`,
    ).run(attempts, runAfterMs ?? null, jobId);
  }

  rehydratable(): DurableBotJob[] {
    if (this.closed) return [];
    // Due pending jobs + expired-lease claimed jobs — jobs still in their
    // retry backoff (run_after in the future) wait until due.
    const rows = this.db.prepare(
      `SELECT * FROM bot_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?)
       UNION ALL SELECT * FROM bot_jobs WHERE state = 'claimed' AND lease_expires_at <= ? ORDER BY created_at`,
    ).all(Date.now(), Date.now()) as any[];
    return rows.map(normalizeJob);
  }

  dueJobs(): DurableBotJob[] {
    const rows = this.db.prepare(
      `SELECT * FROM bot_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at`,
    ).all(Date.now()) as any[];
    return rows.map(normalizeJob);
  }

  pendingJobs(botId: string): DurableBotJob[] {
    const rows = this.db.prepare(
      `SELECT * FROM bot_jobs WHERE bot_id = ? AND state = 'pending' ORDER BY created_at`,
    ).all(botId) as any[];
    return rows.map(normalizeJob);
  }

  enqueueMail(mail: Omit<DurableMail, 'id'>): string {
    const id = randomUUID().slice(0, 12);
    this.db.prepare(
      `INSERT INTO bot_mail (id, bot_id, from_bot, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, mail.botId, mail.from, mail.content, mail.createdAt);
    return id;
  }

  drainMail(botId: string): DurableMail[] {
    const rows = this.db.prepare(
      `SELECT * FROM bot_mail WHERE bot_id = ? ORDER BY created_at`,
    ).all(botId) as any[];
    if (rows.length === 0) return [];
    this.db.prepare(`DELETE FROM bot_mail WHERE bot_id = ?`).run(botId);
    return rows.map(r => ({
      id: String(r.id), botId: String(r.bot_id), from: String(r.from_bot),
      content: String(r.content), createdAt: Number(r.created_at),
    }));
  }

  purgeBot(botId: string): void {
    this.db.prepare(`DELETE FROM bot_jobs WHERE bot_id = ?`).run(botId);
    this.db.prepare(`DELETE FROM bot_mail WHERE bot_id = ?`).run(botId);
    this.db.prepare(`DELETE FROM bot_dlq WHERE bot_id = ?`).run(botId);
  }

  listDlq(botId?: string): DlqEntry[] {
    const rows = botId
      ? this.db.prepare(`SELECT * FROM bot_dlq WHERE bot_id = ? ORDER BY dead_at DESC`).all(botId) as any[]
      : this.db.prepare(`SELECT * FROM bot_dlq ORDER BY dead_at DESC`).all() as any[];
    return rows.map(r => ({
      ...normalizeJob(r),
      state: 'dead' as const,
      deadAt: r.dead_at,
    }));
  }

  peekDlq(jobId: string): DurableBotJob | null {
    const row = this.db.prepare(`SELECT * FROM bot_dlq WHERE id = ?`).get(jobId) as any;
    return row ? ({ ...normalizeJob(row), state: 'dead' as const, deadAt: row.dead_at } as any) : null;
  }

  removeFromDlq(jobId: string): DurableBotJob | null {
    const row = this.db.prepare(`SELECT * FROM bot_dlq WHERE id = ?`).get(jobId) as any;
    if (!row) return null;
    this.db.prepare(`DELETE FROM bot_dlq WHERE id = ?`).run(jobId);
    return normalizeJob(row);
  }

  clearDlq(botId?: string): number {
    const before = (this.db.prepare(botId ? `SELECT COUNT(*) AS n FROM bot_dlq WHERE bot_id = ?` : `SELECT COUNT(*) AS n FROM bot_dlq`).get(...(botId ? [botId] : [])) as { n: number }).n;
    if (botId) this.db.prepare(`DELETE FROM bot_dlq WHERE bot_id = ?`).run(botId);
    else this.db.prepare(`DELETE FROM bot_dlq`).run();
    return before;
  }

  counts(): QueueCounts {
    const pending = (this.db.prepare(`SELECT COUNT(*) c FROM bot_jobs WHERE state = 'pending'`).get() as any).c as number;
    const claimed = (this.db.prepare(`SELECT COUNT(*) c FROM bot_jobs WHERE state = 'claimed'`).get() as any).c as number;
    const dlq = (this.db.prepare(`SELECT COUNT(*) c FROM bot_dlq`).get() as any).c as number;
    return { pending, claimed, dlq };
  }

  /** WAL checkpoints on close, releasing the -wal/-shm sidecars too. Idempotent. */
  close(): void {
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed (double teardown must never throw).
    }
  }
}

// ---------------------------------------------------------------------------
// JSON-file lease backend (zero native deps — Termux / old Node fallback)
// ---------------------------------------------------------------------------

const QUEUE_FILE = 'queue.json';

interface QueueFile {
  jobs: DurableBotJob[];
  dlq: DlqEntry[];
  mails: DurableMail[];
}

export class JsonFileQueueBackend implements BotQueueBackend {
  readonly name = 'json-file';
  private file: string;
  private data: QueueFile;
  private dlqCap: number;

  /** Writes are fd-opened-and-closed per op (write-to-rename + fsync) — nothing to release. */
  close(): void { /* no native handles */ }

  constructor(dir: string, dlqCap: number) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, QUEUE_FILE);
    this.dlqCap = dlqCap;
    this.data = existsSync(this.file) ? this.read() : { jobs: [], dlq: [], mails: [] };
  }

  private read(): QueueFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
      return {
        jobs: (parsed.jobs ?? []).map(normalizeJob),
        dlq: (parsed.dlq ?? []).map((d: any) => ({ ...normalizeJob(d), state: 'dead' as const, deadAt: d.deadAt ?? Date.now() })),
        mails: parsed.mails ?? [],
      };
    } catch {
      return { jobs: [], dlq: [], mails: [] };
    }
  }

  /** Atomic rewrite: tmp file + rename (the SessionRepository discipline). */
  private flush(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSyncFsync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  enqueue(job: Omit<DurableBotJob, 'state'>): { job: DurableBotJob; duplicated: boolean } {
    const dup = this.data.jobs.find(j => j.botId === job.botId && j.idempotencyKey === job.idempotencyKey && j.state !== 'dead');
    if (dup) return { job: dup, duplicated: true };
    const stored: DurableBotJob = { ...job, state: 'pending' };
    this.data.jobs.push(stored);
    this.flush();
    return { job: stored, duplicated: false };
  }

  claim(jobId: string, leaseSeconds: number): void {
    const job = this.data.jobs.find(j => j.id === jobId);
    if (job) {
      job.state = 'claimed';
      job.leaseExpiresAt = Date.now() + leaseSeconds * 1000;
      this.flush();
    }
  }

  heartbeatLease(jobId: string, leaseSeconds: number): void {
    const job = this.data.jobs.find(j => j.id === jobId && j.state === 'claimed');
    if (job) {
      job.leaseExpiresAt = Date.now() + leaseSeconds * 1000;
      this.flush();
    }
  }

  settle(jobId: string, outcome: 'done' | 'dead', reasonCode?: string): void {
    const idx = this.data.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return;
    const [job] = this.data.jobs.splice(idx, 1);
    if (outcome === 'dead') {
      this.data.dlq.unshift({
        ...job, state: 'dead', attempts: job.attempts + 1,
        reasonCode: reasonCode ?? job.reasonCode, deadAt: Date.now(),
      });
      if (this.data.dlq.length > this.dlqCap) this.data.dlq.length = this.dlqCap;
    }
    this.flush();
  }

  requeueExpiredLeases(): number {
    const now = Date.now();
    let n = 0;
    for (const job of this.data.jobs) {
      // Inclusive boundary (matches SQLite's lease_expires_at <= now): a
      // heartbeat to an instant-expiry lease (now + 0) must be sweepable in
      // the SAME millisecond it was written — strict < raced the ms clock
      // and trapped zero-width leases on fast-Linux/Windows fsync.
      if (job.state === 'claimed' && (job.leaseExpiresAt ?? 0) <= now) {
        job.state = 'pending';
        job.leaseExpiresAt = undefined;
        n++;
      }
    }
    if (n > 0) this.flush();
    return n;
  }

  retry(jobId: string, attempts: number, runAfterMs?: number): void {
    const job = this.data.jobs.find(j => j.id === jobId);
    if (job) {
      job.state = 'pending';
      job.attempts = attempts;
      job.leaseExpiresAt = undefined;
      job.runAfter = runAfterMs;
      this.flush();
    }
  }

  rehydratable(): DurableBotJob[] {
    // Due pending + expired-lease claimed (INCLUSIVE — a heartbeat to an
    // instant-expiry lease must be sweepable in the same millisecond;
    // strict < raced the ms clock and trapped zero-width leases).
    // Future run_after waits.
    const now = Date.now();
    return this.data.jobs.filter(j =>
      (j.state === 'pending' && (j.runAfter === undefined || j.runAfter <= now))
      || (j.state === 'claimed' && (j.leaseExpiresAt ?? 0) <= now));
  }

  dueJobs(): DurableBotJob[] {
    const now = Date.now();
    return this.data.jobs.filter(j => j.state === 'pending' && (j.runAfter === undefined || j.runAfter <= now));
  }

  pendingJobs(botId: string): DurableBotJob[] {
    return this.data.jobs.filter(j => j.botId === botId && j.state === 'pending');
  }

  enqueueMail(mail: Omit<DurableMail, 'id'>): string {
    const id = randomUUID().slice(0, 12);
    this.data.mails.push({ ...mail, id });
    this.flush();
    return id;
  }

  drainMail(botId: string): DurableMail[] {
    const drained = this.data.mails.filter(m => m.botId === botId);
    if (drained.length > 0) {
      this.data.mails = this.data.mails.filter(m => m.botId !== botId);
      this.flush();
    }
    return drained;
  }

  purgeBot(botId: string): void {
    const before = this.data.jobs.length + this.data.dlq.length + this.data.mails.length;
    this.data.jobs = this.data.jobs.filter(j => j.botId !== botId);
    this.data.dlq = this.data.dlq.filter(j => j.botId !== botId);
    this.data.mails = this.data.mails.filter(m => m.botId !== botId);
    if (this.data.jobs.length + this.data.dlq.length + this.data.mails.length !== before) this.flush();
  }

  listDlq(botId?: string): DlqEntry[] {
    return this.data.dlq.filter(j => !botId || j.botId === botId);
  }

  peekDlq(jobId: string): DurableBotJob | null {
    return this.data.dlq.find(j => j.id === jobId) ?? null;
  }

  removeFromDlq(jobId: string): DurableBotJob | null {
    const idx = this.data.dlq.findIndex(j => j.id === jobId);
    if (idx === -1) return null;
    const [job] = this.data.dlq.splice(idx, 1);
    this.flush();
    return job;
  }

  clearDlq(botId?: string): number {
    const before = this.data.dlq.length;
    this.data.dlq = botId ? this.data.dlq.filter(j => j.botId !== botId) : [];
    if (this.data.dlq.length !== before) this.flush();
    return before - this.data.dlq.length;
  }

  counts(): QueueCounts {
    return {
      pending: this.data.jobs.filter(j => j.state === 'pending').length,
      claimed: this.data.jobs.filter(j => j.state === 'claimed').length,
      dlq: this.data.dlq.length,
    };
  }
}

import { writeFileSync as writeFdsync, fsyncSync, openSync, closeSync } from 'node:fs';

/** write + fsync before rename so the queue survives a hard power cut. */
function writeFileSyncFsync(file: string, content: string): void {
  const fd = openSync(file, 'w');
  try {
    writeFdsync(fd, content, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}