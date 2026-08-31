import { describe, expect, it } from 'vitest';
import { MouseSequenceFilter, parseMouseSequence, mouseTrackingSequences } from './cli.js';

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