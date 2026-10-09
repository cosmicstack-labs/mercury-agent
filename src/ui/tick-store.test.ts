import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe, getSnapshot, subscriberCount, isRunning, spinnerFrame, elapsedSeconds, TICK_MS, SPINNER_FRAMES } from './tick-store.js';

/**
 * One shared interval for every animated row: it runs only while someone
 * is subscribed, every subscriber sees the same tick, and elapsed time is
 * derived from Date.now() rather than counted per tick.
 */
describe('tick store', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts with the first subscriber and stops with the last', () => {
    expect(isRunning()).toBe(false);
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    expect(isRunning()).toBe(true);
    const offB = subscribe(b);
    expect(subscriberCount()).toBe(2);

    const before = getSnapshot();
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(getSnapshot()).toBe(before + 3);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);

    offA();
    expect(isRunning()).toBe(true);
    offB();
    expect(isRunning()).toBe(false);
    expect(subscriberCount()).toBe(0);

    // No subscribers → the clock is stopped, not ticking in the background.
    const idle = getSnapshot();
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(getSnapshot()).toBe(idle);
  });

  it('a throwing listener does not stop the clock for the others', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const offBad = subscribe(bad);
    const offGood = subscribe(good);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(good).toHaveBeenCalledTimes(2);
    offBad();
    offGood();
  });

  it('spinner frames cycle on the tick and elapsed seconds derive from Date.now()', () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(SPINNER_FRAMES.length + 1)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(1, 3)).toBe(SPINNER_FRAMES[4]);
    expect(elapsedSeconds(undefined)).toBe(0);
    expect(elapsedSeconds(10_000, 13_400)).toBe(3);
    expect(elapsedSeconds(20_000, 13_400)).toBe(0); // never negative
  });
});
