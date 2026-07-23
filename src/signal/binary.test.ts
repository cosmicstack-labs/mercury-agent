import { describe, expect, it } from 'vitest';
import { isNativeAvailable } from './binary.js';

describe('Signal native binary platform selection', () => {
  it('supports glibc Linux targets but excludes Termux', () => {
    expect(isNativeAvailable({}, 'linux', 'x64')).toBe(true);
    expect(isNativeAvailable({ TERMUX_VERSION: '0.119' }, 'linux', 'x64')).toBe(false);
    expect(isNativeAvailable({ PREFIX: '/data/data/com.termux/files/usr' }, 'linux', 'arm64')).toBe(false);
  });
});
