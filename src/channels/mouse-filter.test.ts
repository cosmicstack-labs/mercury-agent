import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MouseSequenceFilter, parseMouseSequence, mouseTrackingSequences, bracketedPasteSequences } from './cli.js';
import { PASTE_SENTINEL, FORWARD_DELETE_KEY } from '../ui/input-composer.js';

function collect() {
  const events: Array<{ button: number; col: number; row: number; wheel: string | null; click: boolean; release: boolean; motion: boolean }> = [];
  const passthrough: string[] = [];
  const filter = new MouseSequenceFilter(
    (ev) => events.push(ev as any),
    (s) => passthrough.push(s),
  );
  return { events, passthrough, filter };
}

describe('MouseSequenceFilter', () => {
  it('parses SGR wheel events', () => {
    const ev = parseMouseSequence('\x1b[<64;10;5M')!;
    expect(ev.wheel).toBe('up');
    expect(ev.col).toBe(9);
    expect(ev.row).toBe(4);
  });

  it('dispatches complete sequences and passes normal typing through', () => {
    const { events, passthrough, filter } = collect();
    filter.push('ab\x1b[<64;3;4Mcd');
    expect(events).toHaveLength(1);
    expect(events[0].wheel).toBe('up');
    expect(passthrough.join('')).toBe('abcd');
  });

  it('joins a mouse sequence split across chunks — tail never leaks', () => {
    // Regression: the pre-filter version dropped the ESC prefix when the
    // sequence straddled two stdin reads, leaking "64;53;5M" into the TUI
    // input as literal keystrokes (terminal-wide garbage + crash).
    const { events, passthrough, filter } = collect();
    for (const piece of ['abc\x1b[<', '64;53;', '5Mdef']) filter.push(piece);
    expect(events).toHaveLength(1);
    expect(events[0].button).toBe(0);
    expect(events[0].wheel).toBe('up');  // 64 = wheel bit
    expect(passthrough.join('')).toBe('abcdef');
  });

  it('joins X10 sequences split across chunks', () => {
    const { events, passthrough, filter } = collect();
    for (const piece of ['\x1b[', 'M\x20', '!!']) filter.push(piece);
    expect(events).toHaveLength(1);
    expect(events[0].col).toBe(0);
    expect(events[0].row).toBe(0);
    expect(passthrough.join('')).toBe('');
  });

  it('passes non-mouse escape sequences through whole', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[A\x1b[Btext\x1b[D');
    expect(passthrough.join('')).toBe('\x1b[A\x1b[Btext\x1b[D');
  });

  it('holds back a bare ESC prefix across the chunk boundary', () => {
    const { events, passthrough, filter } = collect();
    filter.push('hi\x1b');
    expect(passthrough.join('')).toBe('hi');
    filter.push('[<0;5;6M!');
    expect(events).toHaveLength(1);
    expect(passthrough.join('')).toBe('hi!');
  });

  it('passes through other complete sequences while a mouse prefix is pending', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[<');
    filter.push('200;5;5M'); // button 200 → not dispatchable, but consumed
    filter.push('ok');
    expect(passthrough.join('')).toBe('ok');
  });

  it('flushes an unterminated garbage prefix instead of growing unboundedly', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[<' + '9'.repeat(200));
    // Holdback must be discarded, not accumulated forever.
    filter.push('x'.repeat(10));
    expect(passthrough.join('').length).toBeLessThanOrEqual(80);
  });

  it('disable sequence emits the full DEC reset set', () => {
    expect(mouseTrackingSequences(false)).toBe('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    expect(mouseTrackingSequences(true)).toContain('\x1b[?1006h');
  });
});

describe('parseMouseSequence edge cases', () => {
  it('marks drag-motion events and ignores them as clicks', () => {
    const ev = parseMouseSequence('\x1b[<32;7;8M')!;
    expect(ev.motion).toBe(true);
    expect(ev.click).toBe(false);
  });

  it('marks SGR releases with m suffix', () => {
    const ev = parseMouseSequence('\x1b[<0;4;9m')!;
    expect(ev.release).toBe(true);
    expect(ev.click).toBe(false);
  });

  it('returns null for garbage', () => {
    expect(parseMouseSequence('hello')).toBeNull();
    expect(parseMouseSequence('\x1b[A')).toBeNull();
  });
});

describe('MouseSequenceFilter — bracketed paste and key rewrites', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('strips ESC[200~ / ESC[201~ and delivers the payload as ONE sentinel-tagged chunk', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[200~line one\nline two\r\nline three\x1b[201~');
    expect(passthrough).toEqual([PASTE_SENTINEL + 'line one\nline two\r\nline three']);
  });

  it('keeps typed text before and after a paste as separate chunks', () => {
    const { passthrough, filter } = collect();
    filter.push('ab\x1b[200~X\nY\x1b[201~cd');
    expect(passthrough).toEqual(['ab', PASTE_SENTINEL + 'X\nY', 'cd']);
  });

  it('a pasted bare newline is paste payload, never an Enter keystroke', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[200~\n\x1b[201~');
    expect(passthrough).toEqual([PASTE_SENTINEL + '\n']);
  });

  it('joins a paste delivered across several stdin reads, end marker split mid-sequence', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[20');
    expect(passthrough).toEqual([]);
    filter.push('0~first ');
    filter.push('second\x1b[2');
    filter.push('01~tail');
    expect(passthrough.join('|')).toBe(`${PASTE_SENTINEL}first |${PASTE_SENTINEL}second|tail`);
  });

  it('drops ANSI colour escapes inside pasted text', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[200~\x1b[31mred\x1b[0m\x1b[201~');
    expect(passthrough).toEqual([PASTE_SENTINEL + 'red']);
  });

  it('never dispatches mouse events for sequences inside a paste', () => {
    const { events, passthrough, filter } = collect();
    filter.push('\x1b[200~\x1b[<64;5;6Mtext\x1b[201~');
    expect(events).toHaveLength(0);
    expect(passthrough).toEqual([PASTE_SENTINEL + 'text']);
  });

  it('rewrites every Shift+Enter / Ctrl+Enter encoding to Ctrl+N (newline)', () => {
    for (const seq of ['\x1b[13;2u', '\x1b[13;5u', '\x1b[27;2;13~', '\x1b\r']) {
      const { passthrough, filter } = collect();
      filter.push('a' + seq + 'b');
      expect(passthrough, JSON.stringify(seq)).toEqual(['a', '\x0e', 'b']);
    }
  });

  it('rewrites the Delete key (ESC[3~) to the forward-delete sentinel, Home/End to Ctrl+A/Ctrl+E', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[3~');
    filter.push('\x1b[H');
    filter.push('\x1b[F');
    filter.push('\x1bOH\x1b[4~');
    expect(passthrough).toEqual([FORWARD_DELETE_KEY, '\x01', '\x05', '\x01', '\x05']);
  });

  it('releases a lone Esc after the holdback window instead of fusing it with the next key', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b');
    expect(passthrough).toEqual([]);
    vi.advanceTimersByTime(MouseSequenceFilter.HOLDBACK_FLUSH_MS + 1);
    expect(passthrough).toEqual(['\x1b']);
    filter.push('x');
    expect(passthrough).toEqual(['\x1b', 'x']);
    filter.dispose();
  });

  it('a prefix completed within the window is still joined, not flushed early', () => {
    const { passthrough, filter } = collect();
    filter.push('\x1b[');
    vi.advanceTimersByTime(5);
    filter.push('A');
    vi.advanceTimersByTime(100);
    expect(passthrough).toEqual(['\x1b[A']);
  });

  it('bracketed paste DECSET/DECRST sequences', () => {
    expect(bracketedPasteSequences(true)).toBe('\x1b[?2004h');
    expect(bracketedPasteSequences(false)).toBe('\x1b[?2004l');
  });
});
