import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeAttachToken, readAttachToken, createSession } from './auth.js';
import { authGuard } from './middleware.js';

/**
 * Attach-token auth: the machine-local token written at runtime boot lets a
 * second terminal (`mercury attach`) call the web API without the interactive
 * login — but only from loopback connections, and only with a matching token.
 */

describe('attach token', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-attach-'));
    process.env.MERCURY_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips through the owner-only token file', () => {
    writeAttachToken();
    const token = readAttachToken();
    expect(token).toBeTruthy();
    // Written at boot with 0600 — same trust level as credentials files.
    // Windows doesn't enforce POSIX modes: stat reports 0666 for any
    // writable file, so the mode assertion only holds on POSIX systems.
    if (platform() !== 'win32') {
      expect(statSync(join(home, 'attach-token')).mode & 0o777).toBe(0o600);
    }
    // Rotated per boot: each write replaces the token.
    const first = token;
    writeAttachToken();
    expect(readAttachToken()).not.toBe(first);
  });

  it('accepts the attach token from a loopback connection', async () => {
    writeAttachToken();
    const token = readAttachToken()!;
    let nextCalled = false;
    const result = await authGuard(makeContext('/api/chat/models', token, '127.0.0.1'), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(result).toBeUndefined();
  });

  it('rejects the attach token from a non-loopback connection', async () => {
    writeAttachToken();
    const token = readAttachToken();
    let nextCalled = false;
    const result = await authGuard(makeContext('/api/chat/models', token!, '10.0.0.7'), async () => { nextCalled = true; }) as { status?: number };
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it('rejects a wrong token even from loopback', async () => {
    writeAttachToken();
    let nextCalled = false;
    const result = await authGuard(makeContext('/api/chat/models', 'deadbeef'.repeat(8), '127.0.0.1'), async () => { nextCalled = true; }) as { status?: number };
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it('still accepts regular web session tokens for API calls', async () => {
    const token = createSession();
    let nextCalled = false;
    const result = await authGuard(makeContext('/api/chat/models', token, '10.0.0.7'), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(result).toBeUndefined();
  });
});

interface FakeContext {
  req: {
    url: string;
    header: (name: string) => string | undefined;
  };
  env: {
    incoming: { socket: { remoteAddress: string } };
  };
  json: (body: unknown, status?: number) => { body: unknown; status: number };
}

function makeContext(path: string, token: string, remoteAddress: string): any {
  return {
    req: {
      url: `http://127.0.0.1:6174${path}`,
      raw: new Request(`http://127.0.0.1:6174${path}`),
      headers: new Headers(),
      header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
    },
    env: { incoming: { socket: { remoteAddress } } },
    json: (body: unknown, status = 200) => ({ body, status }),
  };
}