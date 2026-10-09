import { useSyncExternalStore } from 'react';

/**
 * One shared 100 ms tick for every animated row in the TUI.
 *
 * Before this module each spinner / elapsed counter / size poll owned its
 * own `setInterval` (80 ms, 80 ms per running step, 250 ms, 100 ms, 500 ms):
 * five unsynchronised timers each committing a React frame, so a busy
 * screen repainted far more often than any one of them intended. Now there
 * is a single interval that runs ONLY while someone is subscribed, and
 * every consumer re-renders on the same edge. Elapsed times are derived
 * from `Date.now()` at render, never accumulated per tick.
 *
 * `subscribe` / `getSnapshot` are the `useSyncExternalStore` pair; the
 * `useTick(active)` hook is the convenience wrapper (an inactive consumer
 * is not subscribed at all, so a frozen screen keeps no timer alive).
 */
export const TICK_MS = 100;

const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick += 1;
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener must never stop the clock */ }
    }
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Subscribe to the shared tick; the interval starts with the first subscriber and stops with the last. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Current tick count (monotonic while anyone is subscribed). */
export function getSnapshot(): number {
  return tick;
}

/** Number of live subscribers (tests / diagnostics). */
export function subscriberCount(): number {
  return listeners.size;
}

/** True while the shared interval is running. */
export function isRunning(): boolean {
  return timer !== null;
}

const noopSubscribe = (): (() => void) => () => {};
const zeroSnapshot = (): number => 0;

/**
 * Re-render on every shared tick while `active`; when inactive the
 * component is not subscribed and sees a constant 0.
 */
export function useTick(active = true): number {
  return useSyncExternalStore(
    active ? subscribe : noopSubscribe,
    active ? getSnapshot : zeroSnapshot,
    active ? getSnapshot : zeroSnapshot,
  );
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Spinner glyph for a tick (optionally offset so parallel rows differ). */
export function spinnerFrame(tickValue: number, offset = 0): string {
  return SPINNER_FRAMES[Math.abs(tickValue + offset) % SPINNER_FRAMES.length];
}

/** Whole seconds elapsed since `startedAt` (0 when unknown). */
export function elapsedSeconds(startedAt: number | undefined | null, now = Date.now()): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
