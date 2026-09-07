import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './fetch-url.js';

describe('SSRF guard — private address classification', () => {
  it('blocks loopback and link-local (cloud metadata)', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.8.8.8')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
  });

  it('blocks RFC1918 and reserved ranges', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just past the private band
    expect(isPrivateAddress('100.63.0.1')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('rejects non-IP strings', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('SSRF guard — credential file hardening', () => {
  it('auth module repairs file permissions', () => {
    // Source guard: the credential writers must use the 0o600 helper.
    const fs = require('node:fs');
    const src = fs.readFileSync(
      new URL('../../web/auth.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('writeCredentialFile(getWebConfigPath()');
    expect(src).toContain('writeCredentialFile(getSessionFilePath()');
    expect(src).toContain('chmodSync(path, 0o600)');
    expect(src).not.toContain("'Mercury@123'");
  });
});