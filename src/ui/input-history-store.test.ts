import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendInputHistory,
  decodeHistoryLine,
  encodeHistoryLine,
  historyFilePath,
  loadInputHistory,
  saveInputHistory,
  HISTORY_LIMIT,
} from './input-history-store.js';
import { createInputHistoryState, historyPrev, pushHistoryLine, INPUT_HISTORY_LIMIT } from './input-composer.js';

describe('persistent input history (~/.mercury/history)', () => {
  let home = '';
  let file = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-history-'));
    file = historyFilePath(join(home, 'nested', '.mercury'));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('round-trips multi-line entries and backslashes as single rows', () => {
    const line = 'fix this:\nconst a = "x\\\\y";';
    expect(decodeHistoryLine(encodeHistoryLine(line))).toBe(line);
    expect(encodeHistoryLine(line).includes('\n')).toBe(false);
  });

  it('creates the directory, writes mode 0600, and loads oldest-first', () => {
    expect(loadInputHistory(file)).toEqual([]);
    let lines = appendInputHistory([], 'first', file);
    lines = appendInputHistory(lines, 'second\nline', file);
    lines = appendInputHistory(lines, 'second\nline', file); // consecutive dup collapses
    lines = appendInputHistory(lines, '   ', file);          // blanks are skipped
    expect(lines).toEqual(['first', 'second\nline']);
    expect(loadInputHistory(file)).toEqual(['first', 'second\nline']);
    // Windows has no POSIX modes (stat reports 0666 for any writable file).
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps only the newest HISTORY_LIMIT lines on disk and on load', () => {
    const many = Array.from({ length: HISTORY_LIMIT + 25 }, (_, i) => `cmd ${i}`);
    expect(saveInputHistory(many, file)).toBe(true);
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(rows).toHaveLength(HISTORY_LIMIT);
    expect(rows[0]).toBe('cmd 25');
    // An over-long file written by something else is still capped on load.
    writeFileSync(file, Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => `x${i}`).join('\n') + '\n');
    const loaded = loadInputHistory(file);
    expect(loaded).toHaveLength(HISTORY_LIMIT);
    expect(loaded[loaded.length - 1]).toBe(`x${HISTORY_LIMIT + 9}`);
  });

  it.skipIf(process.platform === 'win32')('tightens the mode of a pre-existing world-readable file', () => {
    saveInputHistory(['a'], file);
    writeFileSync(file, 'a\n', { mode: 0o644 });
    // chmod on an existing path: writeFileSync keeps 0o644 unless we fix it
    saveInputHistory(['a', 'b'], file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('seeds the composer history so ↑ recalls the previous session, with the same cap', () => {
    const seeded = createInputHistoryState(['older', 'newest']);
    expect(historyPrev(seeded, 'draft').input).toBe('newest');
    expect(INPUT_HISTORY_LIMIT).toBe(HISTORY_LIMIT);
    let state = createInputHistoryState();
    for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i++) state = pushHistoryLine(state, `l${i}`);
    expect(state.history).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(state.history[0]).toBe('l5');
  });

  it('never throws when the history file cannot be written', () => {
    expect(saveInputHistory(['x'], join(home, 'not-a-dir-file', 'x', 'history'))).toBe(true); // creates dirs
    writeFileSync(join(home, 'blocker'), '');
    expect(saveInputHistory(['x'], join(home, 'blocker', 'history'))).toBe(false);
    expect(loadInputHistory(join(home, 'blocker', 'history'))).toEqual([]);
  });
});
