import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from './config.js';

/**
 * Day-by-day token ledger: `~/.mercury/token-history.json`.
 *
 * The daily budget counter (tokens.ts) resets at midnight and forgets the
 * day; this keeps one small row per local calendar day so clients can draw
 * history (the desktop app's activity heat map) and, later, trends.
 * Rows: tokens, input, output, requests. Capped at ~3 years.
 */

export interface DayUsage {
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

interface HistoryFile {
  version: 1;
  days: Record<string, Omit<DayUsage, 'date'>>;
}

const FILE = 'token-history.json';
const MAX_DAYS = 1100;

export function historyPath(): string {
  return join(getMercuryHome(), FILE);
}

/** YYYY-MM-DD in the machine's local time zone. */
export function localDay(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function read(): HistoryFile {
  const path = historyPath();
  if (!existsSync(path)) return { version: 1, days: {} };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HistoryFile>;
    if (data.version !== 1 || !data.days || typeof data.days !== 'object') return { version: 1, days: {} };
    return { version: 1, days: data.days };
  } catch {
    return { version: 1, days: {} };
  }
}

function write(file: HistoryFile): void {
  const keys = Object.keys(file.days).sort();
  if (keys.length > MAX_DAYS) for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete file.days[k];
  const home = getMercuryHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const path = historyPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file), 'utf-8');
  renameSync(tmp, path);
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Add one request's tokens to its day. Never throws: history is a convenience. */
export function recordDay(inputTokens: number, outputTokens: number, totalTokens: number, at: number = Date.now()): void {
  try {
    const file = read();
    const key = localDay(at);
    const row = file.days[key] ?? { tokens: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    row.tokens += n(totalTokens) || n(inputTokens) + n(outputTokens);
    row.inputTokens += n(inputTokens);
    row.outputTokens += n(outputTokens);
    row.requests += 1;
    file.days[key] = row;
    write(file);
  } catch { /* best effort */ }
}

/** First run with history: start it from today's counter so today isn't blank. */
export function seedToday(tokens: number, inputTokens: number, outputTokens: number, requests: number): void {
  try {
    const file = read();
    const key = localDay();
    if (file.days[key] || n(tokens) === 0) return;
    file.days[key] = { tokens: n(tokens), inputTokens: n(inputTokens), outputTokens: n(outputTokens), requests: n(requests) };
    write(file);
  } catch { /* best effort */ }
}

/** The last `days` days, oldest first, with empty days filled in. */
export function readHistory(days: number, now: Date = new Date()): DayUsage[] {
  const file = read();
  const out: DayUsage[] = [];
  const count = Math.max(1, Math.min(MAX_DAYS, Math.floor(days)));
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDay(d);
    const row = file.days[key];
    out.push({ date: key, tokens: n(row?.tokens), inputTokens: n(row?.inputTokens), outputTokens: n(row?.outputTokens), requests: n(row?.requests) });
  }
  return out;
}

/** The earliest day the ledger has, or null. */
export function historySince(): string | null {
  const keys = Object.keys(read().days).sort();
  return keys[0] ?? null;
}
