import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StallWatchdog, stallHardThresholdMs, stallSoftThresholdMs } from './stall-watchdog.js';

describe('stall watchdog thresholds', () => {
  it('defaults are 3 and 8 minutes', () => {
    expect(stallSoftThresholdMs()).toBe(3 * 60 * 1000);
    expect(stallHardThresholdMs(3 * 60 * 1000)).toBe(8 * 60 * 1000);
  });

  it('honors env overrides', () => {
    process.env.MERCURY_STALL_SOFT_MS = '1000';
    process.env.MERCURY_STALL_HARD_MS = '2000';
    expect(stallSoftThresholdMs()).toBe(1000);
    expect(stallHardThresholdMs()).toBe(2000);
    delete process.env.MERCURY_STALL_SOFT_MS;
    delete process.env.MERCURY_STALL_HARD_MS;
  });
});

describe('StallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWatchdog(heartbeat: { at: number }, events: string[]) {
    return new StallWatchdog({
      tickMs: 1000,
      getHeartbeat: () => heartbeat.at,
      getActivity: () => 'Analyzing',
      onSoft: () => events.push('soft'),
      onHard: () => events.push('hard'),
    });
  }

  it('fires soft once, then hard once, for a silent task', () => {
    vi.setSystemTime(1_000_000);
    const heartbeat = { at: 1_000_000 };
    const events: string[] = [];
    const watchdog = makeWatchdog(heartbeat, events);
    watchdog.start();

    vi.advanceTimersByTime(3 * 60 * 1000 + 1000);
    expect(events).toEqual(['soft']);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(events).toEqual(['soft', 'hard']);

    // Hard escalation is terminal — no repeat firings.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(events).toEqual(['soft', 'hard']);
    watchdog.stop();
  });

  it('suppresses escalation when activity keeps arriving', () => {
    vi.setSystemTime(1_000_000);
    const heartbeat = { at: 1_000_000 };
    const events: string[] = [];
    const watchdog = makeWatchdog(heartbeat, events);
    watchdog.start();

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(60 * 1000);
      heartbeat.at += 60 * 1000; // progress arrives every minute
      watchdog.activity();
    }
    expect(events).toEqual([]);
    watchdog.stop();
  });

  it('restarts the stall window after activity', () => {
    const base = 1_000_000;
    vi.setSystemTime(base);
    const heartbeat = { at: base };
    const events: string[] = [];
    const watchdog = makeWatchdog(heartbeat, events);
    watchdog.start();

    vi.advanceTimersByTime(3 * 60 * 1000 + 1000);
    expect(events).toEqual(['soft']);
    heartbeat.at = base + 3 * 60 * 1000 + 1000;
    watchdog.activity();
    vi.advanceTimersByTime(4 * 60 * 1000); // only 4 min past the new heartbeat
    // Soft re-fires once per stall window — a new window earns a new pulse.
    expect(events).toEqual(['soft', 'soft']);
    vi.advanceTimersByTime(4 * 60 * 1000); // now 8 min silent — hard threshold
    expect(events).toEqual(['soft', 'soft', 'hard']);
    watchdog.stop();
  });

  it('stop() disarms and start() can re-arm cleanly', () => {
    vi.setSystemTime(1_000_000);
    const heartbeat = { at: 1_000_000 };
    const events: string[] = [];
    const watchdog = makeWatchdog(heartbeat, events);
    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(events).toEqual([]);

    watchdog.start();
    vi.advanceTimersByTime(8 * 60 * 1000 + 2000);
    expect(events).toEqual(['soft', 'hard']);
    watchdog.stop();
  });
});