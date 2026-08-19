import { describe, expect, it } from 'vitest';
import { isTermux, resolveShell } from './platform.js';

describe('isTermux', () => {
  it('detects Termux environment markers on Linux', () => {
    expect(isTermux({ TERMUX_VERSION: '0.119' }, 'linux')).toBe(true);
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' }, 'linux')).toBe(true);
  });

  it('does not classify desktop Linux or non-Linux platforms as Termux', () => {
    expect(isTermux({}, 'linux')).toBe(false);
    expect(isTermux({ TERMUX_VERSION: '0.119' }, 'darwin')).toBe(false);
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
