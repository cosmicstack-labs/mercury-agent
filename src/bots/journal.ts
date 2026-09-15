import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_JOURNAL_FILENAME, assertValidBotId } from './store.js';
import type { BotRunRecord } from './types.js';

/**
 * Append-only per-bot run journal — the permanent compact record of every
 * run (one line per run; bulky transcripts are evicted separately, see
 * BOTS-ARCHITECTURE.md §2.10). Rotates at a byte threshold, keeping a fixed
 * number of rotations, so a bot running for years is bounded in size.
 */
export class BotJournal {
  private readonly dir: string;
  private readonly rotateBytes: number;
  private readonly keepRotations: number;

  constructor(dir: string, rotateBytes = 5 * 1024 * 1024, keepRotations = 3) {
    this.dir = dir;
    this.rotateBytes = rotateBytes;
    this.keepRotations = keepRotations;
  }

  append(record: BotRunRecord): void {
    assertValidBotId(record.botId);
    this.rotateIfNeeded();
    try {
      appendFileSync(join(this.dir, BOT_JOURNAL_FILENAME), JSON.stringify(record) + '\n', 'utf-8');
    } catch (err: any) {
      // Journaling must never break a run — the queue/state carries the outcome.
      console.error(`[bots] journal append failed for ${record.botId}: ${err?.message}`);
    }
  }

  /** Most recent records, newest last. */
  read(botId: string, limit = 20): BotRunRecord[] {
    assertValidBotId(botId);
    const file = join(this.dir, BOT_JOURNAL_FILENAME);
    if (!existsSync(file)) return [];
    const lines = readLines(file);
    return lines.slice(-limit);
  }

  counts(botId: string): { total: number; completed: number; failed: number; bytes: number } {
    assertValidBotId(botId);
    const file = join(this.dir, BOT_JOURNAL_FILENAME);
    const files = [file, ...rotationFiles(this.dir, this.keepRotations)];
    let total = 0, completed = 0, failed = 0, bytes = 0;
    for (const f of files) {
      if (!existsSync(f)) continue;
      bytes += statSync(f).size;
      for (const rec of readLines(f)) {
        total++;
        if (rec.state === 'completed') completed++;
        if (rec.state === 'failed') failed++;
      }
    }
    return { total, completed, failed, bytes };
  }

  private rotateIfNeeded(): void {
    const file = join(this.dir, BOT_JOURNAL_FILENAME);
    if (!existsSync(file) || statSync(file).size < this.rotateBytes) return;
    // Drop the oldest rotation first, then shift: .N-1→.N, …, journal→.1
    const oldest = join(this.dir, `${BOT_JOURNAL_FILENAME}.${this.keepRotations}`);
    if (existsSync(oldest)) rmSync(oldest);
    for (let i = this.keepRotations - 1; i >= 1; i--) {
      const from = join(this.dir, `${BOT_JOURNAL_FILENAME}.${i}`);
      const to = join(this.dir, `${BOT_JOURNAL_FILENAME}.${i + 1}`);
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(file, join(this.dir, `${BOT_JOURNAL_FILENAME}.1`));
  }
}

function readLines(file: string): BotRunRecord[] {
  const out: BotRunRecord[] = [];
  try {
    const content = statSync(file).size > 0 ? readFileSync(file, 'utf-8') : '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as BotRunRecord);
      } catch { /* skip corrupt line — never break reads on one bad row */ }
    }
  } catch { /* missing/unreadable file = empty journal */ }
  return out;
}

function rotationFiles(dir: string, keep: number): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const match = /^journal\.jsonl\.(\d+)$/.exec(name);
      if (match && parseInt(match[1], 10) <= keep) out.push(join(dir, name));
    }
  } catch { /* no dir yet */ }
  return out;
}