import { describe, expect, it } from 'vitest';
import {
  applyEditKey,
  backspaceAt,
  cleanPrintableInput,
  ctrlCAction,
  cursorColumn,
  deleteForwardAt,
  insertInputChunk,
  isPasteChunk,
  prevGraphemeBoundary,
  nextGraphemeBoundary,
  wordBoundaryLeft,
  wordBoundaryRight,
  CTRL_C_EXIT_WINDOW_MS,
  FORWARD_DELETE_KEY,
  PASTE_SENTINEL,
  type EditorKey,
} from './input-composer.js';

const K = (k: Partial<EditorKey> = {}): EditorKey => k;

/** Drive the reducer with a sequence of (ch, key) pairs. */
function type(start: { input: string; cursorPos: number }, keys: Array<[string | undefined, EditorKey]>) {
  let state = start;
  for (const [ch, key] of keys) {
    const next = applyEditKey(state.input, state.cursorPos, ch, key);
    if (next) state = next;
  }
  return state;
}

describe('composer key handling — paste', () => {
  it('cleanPrintableInput keeps newlines and tabs, normalises CRLF, drops control bytes', () => {
    expect(cleanPrintableInput('a\r\nb\rc\td\x00\x07e\x1b[31m')).toBe('a\nb\nc\td' + 'e' + '[31m');
  });

  it('a multi-line paste (plain useInput chunk) inserts every line at the cursor', () => {
    const r = insertInputChunk('xy', 1, 'one\ntwo\nthree');
    expect(r.input).toBe('xone\ntwo\nthreey');
    expect(r.cursorPos).toBe(1 + 'one\ntwo\nthree'.length);
  });

  it('a bracketed-paste chunk is a literal multi-line insert and never submits', () => {
    const chunk = PASTE_SENTINEL + 'first\nsecond\n';
    expect(isPasteChunk(chunk)).toBe(true);
    // Ink reports a chunk ending in "\n" with no return flag; a chunk that
    // IS "\n" would carry key.return — the reducer still inserts it.
    const r = applyEditKey('', 0, chunk, K({ return: true }));
    expect(r).toEqual({ input: 'first\nsecond\n', cursorPos: 13 });
    const lone = applyEditKey('ab', 1, PASTE_SENTINEL + '\n', K({ return: true, name: 'enter' }));
    expect(lone).toEqual({ input: 'a\nb', cursorPos: 2 });
  });

  it('the paste sentinel never lands in the buffer', () => {
    const r = insertInputChunk('', 0, PASTE_SENTINEL + 'x' + PASTE_SENTINEL);
    expect(r.input).toBe('x');
  });

  it('Shift+Enter (rewritten to Ctrl+N by the stdin filter) inserts a newline', () => {
    const r = type({ input: 'ab', cursorPos: 1 }, [['n', K({ ctrl: true })], ['\x0e', K({ ctrl: true })]]);
    expect(r).toEqual({ input: 'a\n\nb', cursorPos: 3 });
  });

  it('plain Enter is not an editing key (caller submits)', () => {
    expect(applyEditKey('abc', 3, '', K({ return: true }))).toBeNull();
    expect(applyEditKey('abc', 3, '\n', K({ name: 'enter' }))).toBeNull();
  });

  it('flood guard clamps without splitting a surrogate pair', () => {
    const big = 'a'.repeat(7999);
    const r = insertInputChunk(big, big.length, '😀😀');
    expect(r.input.length).toBeLessThanOrEqual(8000);
    expect(r.input.endsWith('a')).toBe(true); // the emoji could not fit whole
    expect(/[\uD800-\uDBFF]$/.test(r.input)).toBe(false);
  });
});

describe('composer key handling — Ctrl+C semantics', () => {
  it('clears a non-empty input', () => {
    expect(ctrlCAction('hello', null, 1000)).toBe('clear');
    expect(ctrlCAction('hello', 900, 1000)).toBe('clear');
  });

  it('arms on an empty input and exits only on a second tap within the window', () => {
    expect(ctrlCAction('', null, 1000)).toBe('arm');
    expect(ctrlCAction('', 1000, 1000 + CTRL_C_EXIT_WINDOW_MS)).toBe('exit');
    expect(ctrlCAction('', 1000, 1000 + CTRL_C_EXIT_WINDOW_MS + 1)).toBe('arm');
  });
});

describe('composer key handling — grapheme-aware cursor', () => {
  const family = '👨‍👩‍👧';
  const flag = '🇯🇵';
  const text = `a${family}b${flag}c`;

  it('backspace removes a whole emoji ZWJ sequence, not a code unit', () => {
    const pos = 1 + family.length;
    expect(backspaceAt(text, pos)).toEqual({ input: `ab${flag}c`, cursorPos: 1 });
  });

  it('forward delete removes the grapheme under the cursor', () => {
    expect(deleteForwardAt(text, 1)).toEqual({ input: `ab${flag}c`, cursorPos: 1 });
    expect(applyEditKey(text, 1, FORWARD_DELETE_KEY, K())).toEqual({ input: `ab${flag}c`, cursorPos: 1 });
  });

  it('← / → step by grapheme and never stop inside a surrogate pair', () => {
    expect(nextGraphemeBoundary(text, 1)).toBe(1 + family.length);
    expect(prevGraphemeBoundary(text, 1 + family.length)).toBe(1);
    const r = type({ input: text, cursorPos: 0 }, [['', K({ rightArrow: true })], ['', K({ rightArrow: true })]]);
    expect(r.cursorPos).toBe(1 + family.length);
    const l = type({ input: text, cursorPos: text.length }, [['', K({ leftArrow: true })], ['', K({ leftArrow: true })]]);
    expect(l.cursorPos).toBe(1 + family.length + 1);
  });

  it('combining marks stay attached to their base', () => {
    const s = 'éx'; // é as e + combining acute
    expect(backspaceAt(s, 2)).toEqual({ input: 'x', cursorPos: 0 });
    expect(nextGraphemeBoundary(s, 0)).toBe(2);
  });

  it('cursor column uses display width: CJK and emoji are two cells wide', () => {
    expect(cursorColumn('日本語x', 3)).toBe(6);
    expect(cursorColumn(`${family}x`, family.length)).toBe(2);
    expect(cursorColumn('a\tb', 2)).toBe(3); // tab expands to two spaces
  });
});

describe('composer key handling — readline editing', () => {
  it('Ctrl+W deletes the previous word, Ctrl+U to line start, Ctrl+K to line end', () => {
    expect(applyEditKey('foo bar baz', 11, 'w', K({ ctrl: true }))).toEqual({ input: 'foo bar ', cursorPos: 8 });
    expect(applyEditKey('one\ntwo three', 7, 'u', K({ ctrl: true }))).toEqual({ input: 'one\n three', cursorPos: 4 });
    expect(applyEditKey('one\ntwo three', 7, 'k', K({ ctrl: true }))).toEqual({ input: 'one\ntwo', cursorPos: 7 });
  });

  it('Alt+← / Alt+→ (and Alt+B / Alt+F, Ctrl+arrows) move by word', () => {
    const s = 'alpha beta  gamma';
    expect(wordBoundaryLeft(s, s.length)).toBe(12);
    expect(wordBoundaryRight(s, 0)).toBe(5);
    expect(applyEditKey(s, s.length, '', K({ meta: true, leftArrow: true }))!.cursorPos).toBe(12);
    expect(applyEditKey(s, 12, 'b', K({ meta: true }))!.cursorPos).toBe(6);
    expect(applyEditKey(s, 0, 'f', K({ meta: true }))!.cursorPos).toBe(5);
    expect(applyEditKey(s, 5, '', K({ ctrl: true, rightArrow: true }))!.cursorPos).toBe(10);
  });

  it('Ctrl+A / Ctrl+E go to the start / end of the CURRENT line in multi-line input', () => {
    expect(applyEditKey('ab\ncd', 4, 'a', K({ ctrl: true }))!.cursorPos).toBe(3);
    expect(applyEditKey('ab\ncd', 3, 'e', K({ ctrl: true }))!.cursorPos).toBe(5);
  });

  it('unbound control / meta chords are left to the caller', () => {
    expect(applyEditKey('x', 1, 'p', K({ ctrl: true }))).toBeNull();
    expect(applyEditKey('x', 1, 'z', K({ meta: true }))).toBeNull();
  });
});
