import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from './login-limiter.js';

describe('login limiter', () => {
  it('allows up to the limit, then locks for the lockout window, then forgets', () => {
    let t = 1_000_000;
    const limiter = createLoginLimiter({ maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000, now: () => t });
    const ip = '10.0.0.1';
    expect(limiter.retryAfterSeconds(ip)).toBe(0);
    limiter.recordFailure(ip);
    limiter.recordFailure(ip);
    expect(limiter.retryAfterSeconds(ip)).toBe(0);
    limiter.recordFailure(ip);
    expect(limiter.retryAfterSeconds(ip)).toBe(30);
    t += 10_000;
    expect(limiter.retryAfterSeconds(ip)).toBe(20);
    t += 21_000;
    expect(limiter.retryAfterSeconds(ip)).toBe(0);
  });

  it('a success clears the slate', () => {
    const limiter = createLoginLimiter({ maxFailures: 2 });
    limiter.recordFailure('a');
    limiter.reset('a');
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });

  it('old failures outside the window do not count', () => {
    let t = 0;
    const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 1_000, now: () => t });
    limiter.recordFailure('a');
    t += 5_000;
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });
});
