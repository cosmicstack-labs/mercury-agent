import { describe, expect, it, vi } from 'vitest';
import { accessLabel, disconnectGoogle, googleOverview } from './overview.js';

const gws = { path: '/usr/local/bin/gws', source: 'path' as const };
const finding = { level: 'ok' as const, title: 'gws keeps your Google sign-in encrypted, and the service can find it' };

describe('googleOverview', () => {
  it('starts the version and sign-in checks together', async () => {
    const started: string[] = [];
    let releaseVersion: (v: string) => void = () => {};
    const deps = {
      findGws: vi.fn(() => gws),
      gwsVersion: vi.fn(() => { started.push('version'); return new Promise<string | null>((resolve) => { releaseVersion = resolve; }); }),
      googleStatus: vi.fn(async () => { started.push('status'); return { signedIn: true, account: 'owner@example.com', scopes: [], clientConfigured: true }; }),
      findings: vi.fn(() => [finding]),
    };
    const pending = googleOverview(deps);
    await Promise.resolve();
    expect(started).toEqual(['version', 'status']);
    releaseVersion('0.22.5');
    await expect(pending).resolves.toEqual({
      gws,
      version: '0.22.5',
      status: { signedIn: true, account: 'owner@example.com', scopes: [], clientConfigured: true },
      error: null,
      findings: [finding],
    });
  });

  it('reports a missing gws, and a failed sign-in check as an error', async () => {
    await expect(googleOverview({ findGws: () => null, googleStatus: vi.fn(), findings: vi.fn() })).resolves.toMatchObject({ gws: null, findings: [] });
    const failing = await googleOverview({ findGws: () => gws, googleStatus: async () => { throw new Error('gws crashed'); }, findings: () => [] });
    expect(failing).toMatchObject({ gws, version: null, status: null, error: 'gws crashed' });
  });

  it('labels read-only and write access', () => {
    expect(accessLabel(['openid', 'https://www.googleapis.com/auth/gmail.readonly'])).toBe('read-only');
    expect(accessLabel(['https://www.googleapis.com/auth/gmail.modify'])).toBe('read and write');
  });
});

describe('disconnectGoogle', () => {
  it('signs out, or says why it could not', async () => {
    await expect(disconnectGoogle({ findGws: () => null, googleLogout: vi.fn() })).resolves.toEqual({ kind: 'not-installed' });
    await expect(disconnectGoogle({ findGws: () => gws, googleLogout: async () => ({ removed: 3 }) })).resolves.toEqual({ kind: 'signed-out', removed: 3 });
    await expect(disconnectGoogle({ findGws: () => gws, googleLogout: async () => { throw new Error('locked'); } })).resolves.toEqual({ kind: 'failed', error: 'locked' });
  });
});
