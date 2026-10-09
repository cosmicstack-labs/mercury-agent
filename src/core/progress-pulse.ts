/**
 * Progress pulse — lets long-running tools tell the agent "still alive".
 *
 * The foreground heartbeat and the StallWatchdog both watch the agent's
 * last-progress timestamp. Tools used to never touch it, so a legitimate
 * ten-minute build (run_command with timeout: 600) was aborted at four
 * minutes as a "stalled provider" and the child process kept running.
 * Tools call pulseProgress() while they are doing work; the agent installs
 * the hook once at construction.
 */
let hook: (() => void) | null = null;

export function setProgressPulse(fn: (() => void) | null): void {
  hook = fn;
}

export function pulseProgress(): void {
  try {
    hook?.();
  } catch {
    // A progress pulse must never break a tool.
  }
}

/** Interval at which a running tool re-pulses even without new output. */
export const TOOL_PULSE_INTERVAL_MS = 10_000;
