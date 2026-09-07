/**
 * Task stall watchdog.
 *
 * Regression class: a task went silent mid-flight — provider stalled between
 * chunks, a tool hung outside its own timeout, an await never resolved — and
 * nothing ever intervened. The memory guard covers heap growth; this covers
 * TIME. It watches the last-progress heartbeat and escalates in two stages:
 *
 *  - soft (default 3 min): the UI still shows "working" with no change, so
 *    surface a visible "still working" pulse. Never acts on the task.
 *  - hard (default 8 min): nothing has happened for this long — the task is
 *    almost certainly dead. Escalate: the agent marks the work ledger paused
 *    and asks the user, instead of burning silence forever.
 *
 * Never aborts the loop itself — the escalation callback decides what the
 * agent does. Activity resets (stream chunks, tool events, step transitions
 * all flow through markProgress) suppress every escalation stage.
 */

import { logger } from '../utils/logger.js';

const MINUTE_MS = 60 * 1000;

export function stallSoftThresholdMs(): number {
  const raw = Number(process.env.MERCURY_STALL_SOFT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3 * MINUTE_MS;
}

export function stallHardThresholdMs(softMs?: number): number {
  const raw = Number(process.env.MERCURY_STALL_HARD_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const soft = softMs ?? stallSoftThresholdMs();
  return soft + 5 * MINUTE_MS;
}

export interface StallWatchdogOptions {
  /** Returns the timestamp of the last progress event (Date.now() epoch ms). */
  getHeartbeat: () => number;
  /** Current activity label for surfaced messages. */
  getActivity?: () => string | null | undefined;
  /** Fired once per stall window when silence crosses the soft threshold. */
  onSoft?: (silentMs: number, activity: string | null | undefined) => void;
  /** Fired once when silence crosses the hard threshold; then watching stops. */
  onHard: (silentMs: number, activity: string | null | undefined) => void;
  /** Tick interval override (tests). */
  tickMs?: number;
}

export class StallWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private softFired = false;
  private hardFired = false;
  private readonly tickMs: number;
  private readonly softMs: number;
  private readonly hardMs: number;

  constructor(private readonly options: StallWatchdogOptions) {
    this.tickMs = options.tickMs ?? 15 * 1000;
    this.softMs = stallSoftThresholdMs();
    this.hardMs = stallHardThresholdMs(this.softMs);
  }

  /** Begin watching. Safe to call repeatedly; only the first call arms it. */
  start(): void {
    if (this.timer) return;
    this.softFired = false;
    this.hardFired = false;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Never hold the event loop open for the watchdog.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** A progress event arrived — the stall window restarts. */
  activity(): void {
    this.softFired = false;
    this.hardFired = false;
  }

  private tick(): void {
    if (this.hardFired) return;
    const last = this.options.getHeartbeat();
    if (!last) return;
    const silentMs = Date.now() - last;
    if (silentMs < this.softMs) return;
    const activity = this.options.getActivity?.();
    if (!this.softFired) {
      this.softFired = true;
      this.options.onSoft?.(silentMs, activity);
    }
    if (silentMs >= this.hardMs && !this.hardFired) {
      this.hardFired = true;
      logger.warn({ silentMs, activity }, 'Stall watchdog: hard threshold crossed — escalating');
      this.options.onHard(silentMs, activity);
    }
  }
}