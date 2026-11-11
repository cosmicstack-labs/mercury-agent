import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { screenRows, selectWithArrowKeys } from './arrow-select.js';

/**
 * A long, multi-line menu title — the device token /server shows to copy —
 * is drawn whole, and a redraw clears exactly what was drawn. Counting one
 * row per title cut the token off on the server's terminal.
 */
describe('menu titles that wrap', () => {
  it('counts the rows wrapped lines fill', () => {
    expect(screenRows(['short', 'x'.repeat(100), ''], 40)).toBe(1 + 3 + 1);
    expect(screenRows(['\u001b[1mbold\u001b[22m'], 10)).toBe(1);
  });

  const realOut = { isTTY: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows };
  const realIn = { isTTY: process.stdin.isTTY, setRawMode: (process.stdin as { setRawMode?: unknown }).setRawMode };
  afterEach(() => {
    Object.assign(process.stdout, realOut);
    Object.assign(process.stdin, realIn);
    vi.restoreAllMocks();
  });

  it('draws the whole token, and moves up by every row it drew before redrawing', async () => {
    Object.assign(process.stdout, { isTTY: true, columns: 40, rows: 30 });
    Object.assign(process.stdin, { isTTY: true, setRawMode: () => process.stdin });
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    const ups: number[] = [];
    const readline = await import('node:readline');
    vi.spyOn(readline.default, 'moveCursor').mockImplementation((_s, _dx, dy) => { if (dy) ups.push(dy as number); return true; });
    vi.spyOn(readline.default, 'cursorTo').mockImplementation(() => true);
    vi.spyOn(readline.default, 'clearScreenDown').mockImplementation(() => true);

    const token = `mct_${'a1B2c3D4e5'.repeat(9)}`; // 94 characters: wraps over 3 rows at 40 columns
    const title = `Token for “Laptop” (shown only now):\n\n${token}\n\nPaste it into the device.`;
    const pick = selectWithArrowKeys(title, [{ value: 'ok', label: "I've copied it" }, { value: 'b', label: 'Back' }]);
    process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'return' });
    expect(await pick).toBe('b');

    const frames = written.map((w) => stripVTControlCharacters(w)).filter((w) => w.includes('Token for'));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // The token is on screen in full, every time.
    for (const f of frames) expect(f).toContain(token);
    // The redraw went back up over every row of the first frame (wrapped token rows included).
    const firstRows = screenRows(frames[0].split('\n'), 40);
    expect(ups[0]).toBe(-(firstRows - 1));
  });
});
