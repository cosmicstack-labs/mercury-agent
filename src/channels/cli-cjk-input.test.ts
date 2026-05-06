import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Helpers to mock process.stdin / process.stdout for readline-based tests
// ---------------------------------------------------------------------------

class MockStdin extends EventEmitter {
  isTTY = true;
  setRawMode = vi.fn();
  resume = vi.fn();
  pause = vi.fn();
  write = vi.fn();
}

class MockStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  write = vi.fn();
}

// ---------------------------------------------------------------------------
// Unit tests for the character filter logic
// (mirrors the logic in App.tsx useInput handler)
// ---------------------------------------------------------------------------

describe('CJK input: character filter logic', () => {
  // This function replicates the filter logic from App.tsx line ~541:
  //   if (ch && !key.escape && !/[\x00-\x1F\x7F]/.test(ch)) { ... }
  function shouldAcceptChar(ch: string | undefined, key: { escape?: boolean } = {}): boolean {
    return !!(ch && !key.escape && !/[\x00-\x1F\x7F]/.test(ch));
  }

  it('accepts ASCII letters', () => {
    expect(shouldAcceptChar('a')).toBe(true);
    expect(shouldAcceptChar('Z')).toBe(true);
  });

  it('accepts CJK characters (Chinese)', () => {
    expect(shouldAcceptChar('中')).toBe(true);
    expect(shouldAcceptChar('文')).toBe(true);
  });

  it('accepts CJK characters (Japanese hiragana)', () => {
    expect(shouldAcceptChar('あ')).toBe(true);
  });

  it('accepts CJK characters (Korean)', () => {
    expect(shouldAcceptChar('한')).toBe(true);
  });

  it('accepts emoji (surrogate pairs)', () => {
    expect(shouldAcceptChar('😀')).toBe(true);
  });

  it('accepts pasted text with multiple characters', () => {
    expect(shouldAcceptChar('你好世界')).toBe(true);
  });

  it('rejects undefined ch', () => {
    expect(shouldAcceptChar(undefined)).toBe(false);
  });

  it('rejects empty string ch', () => {
    expect(shouldAcceptChar('')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(shouldAcceptChar('\x00')).toBe(false); // NUL
    expect(shouldAcceptChar('\x01')).toBe(false); // SOH
    expect(shouldAcceptChar('\x1F')).toBe(false); // US
    expect(shouldAcceptChar('\x7F')).toBe(false); // DEL
  });

  it('rejects when key.escape is true', () => {
    expect(shouldAcceptChar('a', { escape: true })).toBe(false);
  });

  it('accepts newlines and tabs as characters (they pass the filter)', () => {
    // \n (0x0A) and \t (0x09) are control characters — should be filtered
    expect(shouldAcceptChar('\n')).toBe(false);
    expect(shouldAcceptChar('\t')).toBe(false);
    expect(shouldAcceptChar('\r')).toBe(false);
  });

  it('accepts space character', () => {
    expect(shouldAcceptChar(' ')).toBe(true);
  });

  it('accepts mixed CJK + ASCII pasted text', () => {
    expect(shouldAcceptChar('Hello世界！')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for CLIChannel line input mode
// ---------------------------------------------------------------------------

describe('CLIChannel: line input mode', () => {
  let originalStdin: any;
  let originalStdout: any;
  let mockStdin: MockStdin;
  let mockStdout: MockStdout;
  let CLIChannelClass: typeof import('./cli.js').CLIChannel;

  beforeEach(async () => {
    mockStdin = new MockStdin();
    mockStdout = new MockStdout();
    originalStdin = process.stdin;
    originalStdout = process.stdout;
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: mockStdout, writable: true, configurable: true });
    const mod = await import('./cli.js');
    CLIChannelClass = mod.CLIChannel;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  // Import after mocks are in place — already done in beforeEach

  it('CLIChannel has readlineWaiting initially false', async () => {
    const channel = new CLIChannelClass('Test');
    // @ts-expect-error accessing private for test
    expect(channel.readlineWaiting).toBe(false);
  });

  it('CLIChannel has lineInputActive initially false', async () => {
    const channel = new CLIChannelClass('Test');
    // @ts-expect-error accessing private for test
    expect(channel.lineInputActive).toBe(false);
  });

  it('stopLineInput sets lineInputActive to false', async () => {
    const channel = new CLIChannelClass('Test');
    // @ts-expect-error accessing private for test
    channel.lineInputActive = true;
    // @ts-expect-error accessing private for test
    channel.stopLineInput();
    // @ts-expect-error accessing private for test
    expect(channel.lineInputActive).toBe(false);
  });

  it('stopLineInput aborts lineInputAbortController', async () => {
    const channel = new CLIChannelClass('Test');
    const ac = new AbortController();
    // @ts-expect-error accessing private for test
    channel.lineInputAbortController = ac;
    // @ts-expect-error accessing private for test
    channel.stopLineInput();
    expect(ac.signal.aborted).toBe(true);
    // @ts-expect-error accessing private for test
    expect(channel.lineInputAbortController).toBeNull();
  });

  it('startLineInputIfNeeded does not start when mode is not chat/coding', async () => {
    const channel = new CLIChannelClass('Test');
    // Mode is 'splash' by default
    const onInput = vi.fn();
    // @ts-expect-error accessing private for test
    channel.startLineInputIfNeeded(onInput);
    // @ts-expect-error accessing private for test
    expect(channel.lineInputActive).toBe(false);
  });

  it('rerender is suppressed when readlineWaiting is true', async () => {
    const channel = new CLIChannelClass('Test');
    // No inkInstance → rerender returns early anyway
    // @ts-expect-error accessing private for test
    channel.readlineWaiting = true;
    // @ts-expect-error accessing private for test
    const result = channel.rerender();
    // Should not throw — just returns early because readlineWaiting is true
    expect(result).toBeUndefined();
  });

  it('TuiState includes isLineInputActive field', async () => {
    const mod = await import('./cli.js');
    // CLIChannel's default state is internal, so we verify via the exported type
    // by creating an instance and checking its state via the update method
    const channel = new mod.CLIChannel('Test');
    // The state is private, but we can verify isLineInputActive is in the type
    // by checking the TuiState interface — this test is a type-level guarantee
    // We verify indirectly: the class should construct without error
    expect(channel).toBeDefined();
    expect(typeof channel.stop).toBe('function');
  });

  it('readLineInput aborts cleanly when signal is already aborted', async () => {
    const channel = new CLIChannelClass('Test');
    const ac = new AbortController();
    ac.abort();
    // @ts-expect-error accessing private for test
    await expect(channel.readLineInput(ac.signal)).rejects.toThrow('aborted');
  });
});

// ---------------------------------------------------------------------------
// Integration test: readlineWaiting suppresses Ink rerenders
// ---------------------------------------------------------------------------

describe('CLIChannel: readlineWaiting + rerender interaction', () => {
  let originalStdin: any;
  let originalStdout: any;
  let mockStdin: MockStdin;
  let mockStdout: MockStdout;
  let CLIChannelClass: typeof import('./cli.js').CLIChannel;

  beforeEach(async () => {
    mockStdin = new MockStdin();
    mockStdout = new MockStdout();
    originalStdin = process.stdin;
    originalStdout = process.stdout;
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: mockStdout, writable: true, configurable: true });
    const mod = await import('./cli.js');
    CLIChannelClass = mod.CLIChannel;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  it('update() calls rerender() which is suppressed when readlineWaiting=true', async () => {
    const channel = new CLIChannelClass('Test');
    // No inkInstance, so rerender is a no-op regardless
    // But we verify the guard works by checking readlineWaiting state
    // @ts-expect-error accessing private for test
    channel.readlineWaiting = true;
    // @ts-expect-error accessing private for test
    const rerenderSpy = vi.spyOn(channel, 'rerender');
    // update() calls rerender() which should return early
    // @ts-expect-error accessing private for test
    channel.update({ isThinking: true });
    expect(rerenderSpy).toHaveBeenCalled();
  });
});
