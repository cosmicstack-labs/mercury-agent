/**
 * Background media jobs (ADR-042 phase 3): a video or song can take
 * minutes, so the tool starts a job and the turn ends. When the job is
 * done, its file goes to the chat that asked (Telegram, WhatsApp, the
 * desktop, the terminal), even if that chat has moved on, exactly once.
 *
 * Jobs are kept in ~/.mercury/media-jobs.json. A job still "running" when
 * Mercury starts was cut off by a restart (the provider call is gone): it is
 * marked failed and the chat is told, so nothing waits forever.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type JobKind = 'video' | 'music';

export interface ChatTarget {
  channelType: string;
  channelId: string;
  /** The canonical session (desktop thread), for keeping the result with the conversation. */
  sessionId?: string;
}

export interface MediaJob {
  id: string;
  kind: JobKind;
  prompt: string;
  /** The shape asked for (video: landscape/portrait), for placeholders. */
  aspect?: string;
  status: 'running' | 'done' | 'failed';
  chat: ChatTarget;
  createdAt: number;
  finishedAt?: number;
  file?: string;
  /** "Gemini Omni Flash · Gemini" */
  madeWith?: string;
  error?: string;
  delivered: boolean;
}

export interface JobOutcome {
  file: string;
  madeWith: string;
  note?: string;
}

const MAX_KEPT = 200;

export class MediaJobs {
  private jobs: MediaJob[] | null = null;
  private running = new Map<string, AbortController>();

  constructor(
    /** Post a finished (or failed) job to its chat. Must not throw for "chat gone". */
    private readonly deliver: (job: MediaJob, note?: string) => Promise<void>,
    private readonly file = join(getMercuryHome(), 'media-jobs.json'),
    /** A job started (a screen shows a placeholder for it). */
    private readonly announce?: (job: MediaJob) => void,
  ) {}

  private load(): MediaJob[] {
    if (this.jobs) return this.jobs;
    try {
      const raw = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : [];
      this.jobs = Array.isArray(raw) ? raw.filter((j) => j && typeof j.id === 'string' && j.chat) : [];
    } catch {
      this.jobs = [];
    }
    return this.jobs;
  }

  private save(): void {
    try {
      const all = this.load();
      if (all.length > MAX_KEPT) all.splice(0, all.length - MAX_KEPT);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
      renameSync(tmp, this.file);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Media jobs: saving failed');
    }
  }

  /**
   * Start a job; resolves at once with it. `run` does the work and may take
   * minutes; its result (or error) is delivered to `chat` when it ends.
   */
  start(kind: JobKind, prompt: string, chat: ChatTarget, run: (signal: AbortSignal) => Promise<JobOutcome>, opts: { aspect?: string } = {}): MediaJob {
    const job: MediaJob = { id: randomUUID().slice(0, 8), kind, prompt: prompt.slice(0, 500), ...(opts.aspect ? { aspect: opts.aspect } : {}), status: 'running', chat, createdAt: Date.now(), delivered: false };
    this.load().push(job);
    this.save();
    try { this.announce?.(job); } catch { /* telling a screen must never stop the job */ }
    const ctrl = new AbortController();
    this.running.set(job.id, ctrl);
    void (async () => {
      let note: string | undefined;
      try {
        const out = await run(ctrl.signal);
        Object.assign(job, { status: 'done', file: out.file, madeWith: out.madeWith, finishedAt: Date.now() });
        note = out.note;
      } catch (err) {
        Object.assign(job, { status: 'failed', error: ctrl.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err), finishedAt: Date.now() });
      } finally {
        this.running.delete(job.id);
      }
      this.save();
      await this.deliverOnce(job, note);
    })();
    return job;
  }

  private async deliverOnce(job: MediaJob, note?: string): Promise<void> {
    if (job.delivered) return;
    job.delivered = true;
    this.save();
    try {
      await this.deliver(job, note);
    } catch (err) {
      logger.warn({ job: job.id, err: err instanceof Error ? err.message : String(err) }, 'Media job: delivering the result failed');
    }
  }

  /** Mercury restarted: jobs that were running are gone; tell their chats. */
  async recover(): Promise<number> {
    const cut = this.load().filter((j) => j.status === 'running' && !this.running.has(j.id));
    for (const job of cut) {
      Object.assign(job, { status: 'failed', error: 'Mercury restarted while it was being made. Ask again to make it.', finishedAt: Date.now() });
    }
    if (cut.length) this.save();
    for (const job of cut) await this.deliverOnce(job);
    // A job that finished but whose delivery never ran (a crash in between).
    for (const job of this.load().filter((j) => j.status !== 'running' && !j.delivered)) await this.deliverOnce(job);
    return cut.length;
  }

  /** Stop running jobs for a chat (or all). */
  stop(chat?: Pick<ChatTarget, 'channelId'>): number {
    let n = 0;
    for (const job of this.load()) {
      if (job.status !== 'running' || (chat && job.chat.channelId !== chat.channelId)) continue;
      this.running.get(job.id)?.abort();
      n++;
    }
    return n;
  }

  /** Newest first; a chat's own, or every chat's. */
  list(chat?: Pick<ChatTarget, 'channelId'>, limit = 10): MediaJob[] {
    return [...this.load()].reverse().filter((j) => !chat || j.chat.channelId === chat.channelId).slice(0, limit);
  }

  /** Test hook: wait for running jobs to settle. */
  async idle(): Promise<void> {
    while (this.running.size) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
  }
}

let jobs: MediaJobs | null = null;
export function setMediaJobs(j: MediaJobs | null): void { jobs = j; }
export function mediaJobs(): MediaJobs | null { return jobs; }
