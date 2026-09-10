import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIChannel } from './cli.js';

/** Notifications flush via setImmediate (check phase) so pending timers —
 * like the memory guard — always get a chance to run between render batches. */
const flushRenders = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CLIChannel render scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never calls inkInstance.rerender — updates flow through store notifications', async () => {
    const channel = new CLIChannel();
    (channel as any).inkInstance = {
      // Any call would be the re-entrant render path that corrupted Yoga.
      rerender: () => {
        throw new Error('imperative rerender is forbidden');
      },
      unmount: () => {},
    };

    let notifications = 0;
    const unsubscribe = channel.subscribeToTuiState(() => { notifications++; });

    channel.setMode('coding');
    channel.setMode('chat');
    // Notifications are deferred (check phase) and coalesced — two updates in
    // one tick must produce exactly one notification, breaking any
    // synchronous re-entrancy cycle with React's commit phase.
    await flushRenders();
    expect(notifications).toBe(1);
    expect(channel.getTuiState().mode).toBe('chat');

    await flushRenders();
    unsubscribe();
    channel.setMode('coding');
    await flushRenders();
    expect(notifications).toBe(1);
  });

  it('does not re-enter synchronously when update() is called from a listener', async () => {
    const channel = new CLIChannel();
    let depth = 0;
    let maxDepth = 0;
    const unsubscribe = channel.subscribeToTuiState(() => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      // Simulate a React effect that writes back to the channel (the
      // scroll-clamp effect does exactly this).
      if (depth === 1) channel.setMode('chat');
      depth -= 1;
    });

    channel.setMode('coding');
    await flushRenders();
    await flushRenders();
    unsubscribe();
    // The listener-triggered update must have been deferred to a later
    // event-loop turn, never nested inside the notification loop.
    expect(maxDepth).toBe(1);
    expect(channel.getTuiState().mode).toBe('chat');
  });

  it('exposes a useSyncExternalStore-compatible snapshot contract', async () => {
    const channel = new CLIChannel();
    // Snapshot must be referentially stable between updates.
    const first = channel.getTuiStateSnapshot();
    const second = channel.getTuiStateSnapshot();
    expect(first).toBe(second);

    let notified = false;
    const unsubscribe = channel.subscribeToTuiState(() => { notified = true; });
    channel.setMode('chat');
    await flushRenders();
    expect(notified).toBe(true);
    expect(channel.getTuiStateSnapshot()).not.toBe(first);
    unsubscribe();
  });

  it('defers TUI unmount until after the React input callback', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    let unmounts = 0;
    let exits = 0;
    (channel as any).inkInstance = { unmount: () => { unmounts++; } };
    (channel as any).exitHandler = () => { exits++; };

    (channel as any).scheduleTuiExit();
    (channel as any).scheduleTuiExit();
    expect(unmounts).toBe(0);
    expect(exits).toBe(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unmounts).toBe(1);
    expect(exits).toBe(1);
  });
});

describe('Mercury Code terminal modes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables mouse wheel scrolling in Mercury Code and disables it on exit', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const channel = new CLIChannel();
    const result = channel.enterMercuryCode(process.cwd(), 'test');

    // Wheel scroll is the only natural way back through a full-screen
    // transcript — mouse reporting must be ON while Mercury Code is active.
    expect(result.ok).toBe(true);
    expect(channel.isMouseEnabled()).toBe(true);
    expect(channel.getTuiState().mercuryCode?.mouse).toBe(true);
    expect(writes.join('')).toContain('\x1b[?1006h');

    channel.exitMercuryCode();
    expect(channel.isMouseEnabled()).toBe(false);
    expect(writes.join('')).toContain('\x1b[?1006l');
  });

  it('adds per-file git statistics to execute-mode completion', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const cwd = mkdtempSync(join(tmpdir(), 'mercury-code-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(join(cwd, 'tracked.txt'), 'before\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd });
      execFileSync('git', ['-c', 'user.name=Mercury Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd });
      writeFileSync(join(cwd, 'tracked.txt'), 'before\nafter\n');
      writeFileSync(join(cwd, 'new.txt'), 'one\ntwo\n');

      const channel = new CLIChannel();
      channel.enterMercuryCode(cwd, 'test');
      channel.setProgrammingStatus('execute', cwd);
      channel.sendCompletion(1200, 2);

      const completion = channel.getTuiState().chatMessages.at(-1);
      expect(completion?.fileChanges).toEqual([
        { path: 'new.txt', added: 2, removed: 0 },
        { path: 'tracked.txt', added: 1, removed: 0 },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CLIChannel transcript memory bounds', () => {
  it('caps each oversized message so total retained chars stay bounded', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    // 2MB blocks — each capped to 64KB in the display.
    const big = 'x'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 3; i++) channel.send(big);

    const messages = channel.getTuiState().chatMessages;
    const total = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(messages.length).toBe(3);
    expect(messages.every((m) => m.content.length <= 64 * 1024 + 200)).toBe(true);
    expect(messages[0].content).toContain('display truncated');
  });

  it('caps a single oversized streamed message in the display', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    const chunk = 'y'.repeat(64 * 1024);
    async function* bigStream() {
      for (let i = 0; i < 20; i++) yield chunk;
    }
    await channel.stream(bigStream());
    const message = channel.getTuiState().chatMessages.at(-1);
    expect(message?.content.length).toBeLessThanOrEqual(64 * 1024 + 200);
    expect(message?.content).toContain('truncated');
  });

  it('keeps a trimmed-transcript notice only when the full-session budget overflows', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    // 100 × 100KB → each capped ~64KB = ~6.4MB > 4MB budget → oldest drop.
    const big = 'z'.repeat(100 * 1024);
    for (let i = 0; i < 100; i++) channel.send(big);
    const messages = channel.getTuiState().chatMessages;
    const total = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024 + 128 * 1024);
    expect(messages[0].content).toContain('earlier transcript trimmed');
  });

  it('retains a realistic full coding session without dropping anything', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    // Simulate a long Mercury Code task: ~150 messages averaging 8KB
    // (≈1.2MB total) — must all survive with no trim notice.
    for (let i = 0; i < 150; i++) channel.send(`step ${i}\n${'content '.repeat(1000)}`);
    const messages = channel.getTuiState().chatMessages;
    expect(messages.length).toBe(150);
    expect(messages[0].content).not.toContain('earlier transcript trimmed');
  });
});
