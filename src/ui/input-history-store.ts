import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * Persistent input history for the terminal UIs: `~/.mercury/history`,
 * one submitted line per row (embedded newlines are escaped as `\n` so a
 * multi-line prompt stays one history entry), newest last, capped to the
 * most recent `HISTORY_LIMIT` lines, mode 0600 (prompts can carry secrets).
 *
 * Loaded once at TUI start; every submission appends and rewrites the
 * capped file. Every operation is best-effort — a read-only or missing
 * home directory must never break input.
 */
export const HISTORY_LIMIT = 500;
export const HISTORY_FILE_NAME = 'history';

export function historyFilePath(home = getMercuryHome()): string {
  return join(home, HISTORY_FILE_NAME);
}

/** Escape a submitted line into one history row. */
export function encodeHistoryLine(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Inverse of `encodeHistoryLine`. */
export function decodeHistoryLine(row: string): string {
  let out = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length) {
      const n = row[i + 1];
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
    }
    out += c;
  }
  return out;
}

/** Read the persisted history (oldest first). Missing / unreadable → []. */
export function loadInputHistory(file = historyFilePath()): string[] {
  try {
    if (!existsSync(file)) return [];
    const rows = readFileSync(file, 'utf8').split('\n').filter((r) => r.length > 0);
    return rows.slice(-HISTORY_LIMIT).map(decodeHistoryLine);
  } catch {
    return [];
  }
}

/** Rewrite the file with the newest `HISTORY_LIMIT` lines, mode 0600. */
export function saveInputHistory(lines: readonly string[], file = historyFilePath()): boolean {
  try {
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = lines.slice(-HISTORY_LIMIT).map(encodeHistoryLine).join('\n');
    writeFileSync(file, body.length > 0 ? body + '\n' : '', { encoding: 'utf8', mode: 0o600 });
    // writeFileSync's mode only applies on creation; an existing file keeps
    // whatever it had — tighten it every time.
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one submitted line. Consecutive duplicates collapse (same rule as
 * the in-memory history). Returns the new in-memory list.
 */
export function appendInputHistory(existing: readonly string[], line: string, file = historyFilePath()): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [...existing];
  if (existing[existing.length - 1] === trimmed) return [...existing];
  const next = [...existing, trimmed].slice(-HISTORY_LIMIT);
  saveInputHistory(next, file);
  return next;
}
