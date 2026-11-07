import { describe, it, expect, vi } from 'vitest';
import { basicAuthHeaders, sendsPasswordInClear, withBaseUrl } from './basic-auth.js';
import type { ProviderConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const base: ProviderConfig = { name: 'openaiCompat', apiKey: '', baseUrl: 'https://x.test/v1', model: 'm', enabled: true };

describe('basicAuthHeaders', () => {
  it('returns nothing without a username', () => {
    expect(basicAuthHeaders(base)).toBeUndefined();
    expect(basicAuthHeaders({ ...base, username: '', password: 'p' })).toBeUndefined();
  });

  it('encodes username:password as a Basic header', () => {
    expect(basicAuthHeaders({ ...base, username: 'alice', password: 's3cret' }))
      .toEqual({ Authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}` });
  });

  it('keeps non-Latin-1 characters and colons in the password', () => {
    const header = basicAuthHeaders({ ...base, username: 'bob', password: 'pä:ß€' })!.Authorization;
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')).toBe('bob:pä:ß€');
  });

  it('treats a missing password as empty', () => {
    const header = basicAuthHeaders({ ...base, username: 'carol' })!.Authorization;
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')).toBe('carol:');
  });
});

describe('sendsPasswordInClear', () => {
  const at = (baseUrl: string, username = 'alice') => sendsPasswordInClear({ baseUrl, username });

  it('flags a username on plain http to another machine', () => {
    expect(at('http://ollama.example.com/v1')).toBe(true);
    expect(at('http://192.168.1.20:11434/v1')).toBe(true);
  });

  it('stays quiet for https, loopback, no username, or a bad URL', () => {
    expect(at('https://ollama.example.com/v1')).toBe(false);
    expect(at('http://127.0.0.1:11434/v1')).toBe(false);
    expect(at('http://localhost:11434/v1')).toBe(false);
    expect(at('http://[::1]:11434/v1')).toBe(false);
    expect(at('http://ollama.example.com/v1', '')).toBe(false);
    expect(at('not a url')).toBe(false);
  });
});

describe('withBaseUrl', () => {
  const saved: ProviderConfig = { ...base, baseUrl: 'https://mine.test/v1', username: 'alice', password: 's3cret' };

  it('keeps the saved credentials for the same server, trailing slash or not', () => {
    expect(withBaseUrl(saved, 'https://mine.test/v1/')).toMatchObject({ username: 'alice', password: 's3cret' });
  });

  it('drops the saved credentials for a different server', () => {
    const next = withBaseUrl(saved, 'https://other.test/v1');
    expect(next.baseUrl).toBe('https://other.test/v1');
    expect(next.username).toBeUndefined();
    expect(next.password).toBeUndefined();
  });
});

describe('basicAuthHeaders plain-http warning', () => {
  it('warns once per server when the password would travel over plain http', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const cfg = { ...base, baseUrl: 'http://warn-once.example.test/v1', username: 'alice', password: 'pw' };
      basicAuthHeaders(cfg);
      basicAuthHeaders(cfg);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain('pw"');
      basicAuthHeaders({ ...cfg, baseUrl: 'https://safe.example.test/v1' });
      basicAuthHeaders({ ...cfg, baseUrl: 'http://127.0.0.1:11434/v1' });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps URL credentials out of the warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      basicAuthHeaders({ ...base, baseUrl: 'http://bob:urlpass@leak-check.example.test/v1', username: 'alice', password: 'pw' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('urlpass');
    } finally {
      warn.mockRestore();
    }
  });
});
