import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './store.js';
import { logger } from '../utils/logger.js';

/**
 * The owner's bot inbox (Bots 2.0): what the bots did for you, kept until you
 * read it, whether or not anything was connected when it happened.
 *
 * One entry per run that matters to the owner:
 *   result     a finding, an answer or delivered files (the bot's bot_report)
 *   failed     the bot said it couldn't do the job (bot_report_failure)
 *   needs-you  the run failed for good (dead-lettered) and waits on you
 * Quiet runs (bot_no_update), crew work handed to a lead, and retries are
 * not here: the journal keeps them.
 */

export type BotInboxKind = 'result' | 'failed' | 'needs-you';

export interface BotInboxEntry {
  id: string;
  botId: string;
  botName: string;
  runId: string;
  kind: BotInboxKind;
  /** Short line for lists and notifications. */
  title: string;
  /** What the bot reported (or why it failed), capped. */
  summary: string;
  /** Delivered files (absolute paths), newest run only. */
  files: string[];
  /** The bot said the job is finished, not just progress. */
  complete?: boolean;
  /** Why it needs you (reason code) for needs-you entries. */
  reasonCode?: string;
  /** A bot's question waiting for your answer (POST /api/bots/approvals/:id). */
  approvalId?: string;
  at: number;
  read: boolean;
}

const FILE = 'inbox.jsonl';
const MAX_SUMMARY = 4000;
/** Rotate when the file grows past this; the newest entries are kept. */
const ROTATE_BYTES = 2 * 1024 * 1024;
const KEEP_AFTER_ROTATE = 500;

export class BotInbox {
  private readonly path: string;
  private readonly readPath: string;
  private listeners = new Set<(e: BotInboxEntry) => void>();

  constructor(botsRoot: string) {
    this.path = join(botsRoot, FILE);
    // Read marks live apart from the append-only log, so appends never rewrite it.
    this.readPath = join(botsRoot, 'inbox-read.json');
    mkdirSync(botsRoot, { recursive: true });
  }

  /** A new entry arrives (the web stream turns it into a desktop notification). */
  onEntry(listener: (e: BotInboxEntry) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  add(input: Omit<BotInboxEntry, 'id' | 'at' | 'read' | 'summary'> & { summary: string; at?: number }): BotInboxEntry {
    const entry: BotInboxEntry = {
      ...input,
      id: randomUUID().slice(0, 12),
      summary: input.summary.length > MAX_SUMMARY ? `${input.summary.slice(0, MAX_SUMMARY)}…` : input.summary,
      title: input.title.slice(0, 160),
      at: input.at ?? Date.now(),
      read: false,
    };
    try {
      this.rotateIfBig();
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, botId: entry.botId }, 'Could not write the bot inbox');
    }
    for (const l of this.listeners) {
      try { l(entry); } catch { /* a listener's problem */ }
    }
    return entry;
  }

  /** Newest first. */
  list(opts: { limit?: number; botId?: string; unreadOnly?: boolean } = {}): BotInboxEntry[] {
    const read = this.readMarks();
    const out: BotInboxEntry[] = [];
    for (const e of this.all().reverse()) {
      if (opts.botId && e.botId !== opts.botId) continue;
      const isRead = read.all >= e.at || read.ids.has(e.id);
      if (opts.unreadOnly && isRead) continue;
      out.push({ ...e, read: isRead });
      if (out.length >= (opts.limit ?? 100)) break;
    }
    return out;
  }

  unread(botId?: string): number {
    return this.list({ unreadOnly: true, botId, limit: 10_000 }).length;
  }

  /** Unread entries per bot, in one pass (the roster asks for every bot at once). */
  unreadByBot(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.list({ unreadOnly: true, limit: 10_000 })) out.set(e.botId, (out.get(e.botId) ?? 0) + 1);
    return out;
  }

  /** Mark entries read: some ids, or everything up to now. */
  markRead(ids?: string[]): void {
    const read = this.readMarks();
    if (!ids) {
      read.all = Date.now();
      read.ids.clear();
    } else {
      for (const id of ids) read.ids.add(id);
    }
    try {
      atomicWrite(this.readPath, JSON.stringify({ all: read.all, ids: [...read.ids].slice(-2000) }) + '\n');
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Could not save inbox read marks');
    }
  }

  private all(): BotInboxEntry[] {
    if (!existsSync(this.path)) return [];
    const out: BotInboxEntry[] = [];
    for (const line of readFileSync(this.path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as BotInboxEntry); } catch { /* a torn last line */ }
    }
    return out;
  }

  private readMarks(): { all: number; ids: Set<string> } {
    try {
      const raw = JSON.parse(readFileSync(this.readPath, 'utf-8')) as { all?: number; ids?: string[] };
      return { all: Number(raw.all) || 0, ids: new Set(raw.ids ?? []) };
    } catch {
      return { all: 0, ids: new Set() };
    }
  }

  private rotateIfBig(): void {
    try {
      if (!existsSync(this.path) || statSync(this.path).size < ROTATE_BYTES) return;
      const keep = this.all().slice(-KEEP_AFTER_ROTATE);
      const tmp = `${this.path}.tmp`;
      atomicWrite(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(tmp, this.path);
    } catch { /* rotation is housekeeping */ }
  }
}
