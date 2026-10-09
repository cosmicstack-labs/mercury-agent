import { describe, expect, it } from 'vitest';
import { isTermux, isTermuxEligiblePlatform, resolveShell } from './platform.js';

describe('isTermux', () => {
  it('detects Termux environment markers on Linux', () => {
    expect(isTermux({ TERMUX_VERSION: '0.119' }, 'linux')).toBe(true);
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' }, 'linux')).toBe(true);
  });

  it('detects Termux when Node reports process.platform === "android" (real devices)', () => {
    // Termux's own nodejs package is an Android build: process.platform is
    // 'android', not 'linux'. Gating on 'linux' alone sent every real phone
    // down the "Unsupported platform: android" service-install path.
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' }, 'android')).toBe(true);
    expect(isTermux({ TERMUX_VERSION: '0.119' }, 'android')).toBe(true);
    expect(isTermux({ TERMUX_APP_PID: '1234' }, 'android')).toBe(true);
  });

  it('does not classify plain Linux, plain Android, or non-Linux platforms as Termux', () => {
    expect(isTermux({}, 'linux')).toBe(false);
    expect(isTermux({ PREFIX: '/usr' }, 'linux')).toBe(false);
    expect(isTermux({}, 'android')).toBe(false);
    expect(isTermux({ TERMUX_VERSION: '0.119' }, 'darwin')).toBe(false);
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' }, 'win32')).toBe(false);
  });
});

describe('isTermuxEligiblePlatform', () => {
  it('accepts linux and android only', () => {
    expect(isTermuxEligiblePlatform('linux')).toBe(true);
    expect(isTermuxEligiblePlatform('android')).toBe(true);
    expect(isTermuxEligiblePlatform('darwin')).toBe(false);
    expect(isTermuxEligiblePlatform('win32')).toBe(false);
  });
});

describe('resolveShell', () => {
  const existing = new Set([
    '/custom/sh',
    '/shell/sh',
    '/data/data/com.termux/files/usr/bin/sh',
    '/bin/sh',
  ]);
  const fileExists = (path: string) => existing.has(path);

  it('uses explicit shell configuration in priority order', () => {
    expect(resolveShell({ MERCURY_SHELL: '/custom/sh', SHELL: '/shell/sh' }, fileExists)).toBe('/custom/sh');
    expect(resolveShell({ MERCURY_SHELL: '/missing', SHELL: '/shell/sh' }, fileExists)).toBe('/shell/sh');
  });

  it('uses the Termux prefix shell before /bin/sh', () => {
    expect(resolveShell({ TERMUX_VERSION: '0.119', PREFIX: '/data/data/com.termux/files/usr' }, fileExists, 'linux'))
      .toBe('/data/data/com.termux/files/usr/bin/sh');
  });
});
