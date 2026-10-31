/**
 * Per-address failure limiter for password endpoints that are reachable
 * without a browser. Small and in-memory on purpose: the goal is to turn an
 * online guess from "thousands per second" into "ten per quarter hour",
 * not to be a WAF. bcrypt already makes each attempt slow.
 */

export interface LoginLimiter {
  /** Seconds the caller must wait, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string): number;
  recordFailure(key: string): void;
  reset(key: string): void;
}

export interface LoginLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const MAX_TRACKED = 10_000;

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const lockoutMs = options.lockoutMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function prune(t: number): void {
    if (entries.size < MAX_TRACKED) return;
    for (const [key, e] of entries) {
      if (e.lockedUntil <= t && t - e.firstFailureAt > windowMs) entries.delete(key);
    }
    // Still full (an attacker spraying addresses): drop the oldest half.
    if (entries.size >= MAX_TRACKED) {
      let i = 0;
      for (const key of entries.keys()) {
        if (i++ % 2 === 0) entries.delete(key);
      }
    }
  }

  return {
    retryAfterSeconds(key) {
      const e = entries.get(key);
      if (!e) return 0;
      const t = now();
      if (e.lockedUntil > t) return Math.max(1, Math.ceil((e.lockedUntil - t) / 1000));
      if (t - e.firstFailureAt > windowMs) entries.delete(key);
      return 0;
    },
    recordFailure(key) {
      const t = now();
      prune(t);
      const e = entries.get(key);
      if (!e || t - e.firstFailureAt > windowMs) {
        entries.set(key, { failures: 1, firstFailureAt: t, lockedUntil: 0 });
        return;
      }
      e.failures += 1;
      if (e.failures >= maxFailures) {
        e.lockedUntil = t + lockoutMs;
        e.failures = 0;
        e.firstFailureAt = t;
      }
    },
    reset(key) {
      entries.delete(key);
    },
  };
}
