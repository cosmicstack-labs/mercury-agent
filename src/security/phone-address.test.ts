import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The config path is fixed when config.ts loads, so point it at a scratch home first.
const home = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-phone-address-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { savePhoneAddress, phoneAddressStatus } = await import('./server-ops.js');
const { loadConfig } = await import('../utils/config.js');
const { isLiveProbe, reachesMercury } = await import('./tunnel.js');
const { runServerCommand } = await import('./server-menu.js');
const { localServerOps } = await import('./server-ops.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('the phone address (/server address)', () => {
  it('saves an https address as web.publicUrl, and pairing uses it first', async () => {
    const r = await savePhoneAddress('https://Mercury.Example.com/some/path', { live: false });
    expect(r).toMatchObject({ ok: true, address: 'https://mercury.example.com' });
    expect(r.message).toContain("wasn't tested");
    expect(loadConfig().web?.publicUrl).toBe('https://mercury.example.com');
    expect(await phoneAddressStatus()).toMatchObject({ saved: 'https://mercury.example.com', address: 'https://mercury.example.com', source: 'saved', problem: null });
  });

  it('refuses plain http to the internet and this-computer-only addresses, and keeps the old one', async () => {
    const insecure = await savePhoneAddress('http://203.0.113.7:8080', { live: false });
    expect(insecure.ok).toBe(false);
    expect(insecure.message).toContain('plain http');
    const loop = await savePhoneAddress('http://127.0.0.1:6174', { live: false });
    expect(loop.ok).toBe(false);
    expect(loadConfig().web?.publicUrl).toBe('https://mercury.example.com');
  });

  it('clears back to automatic', async () => {
    const r = await savePhoneAddress('auto', { live: false });
    expect(r).toMatchObject({ ok: true, address: null });
    expect(loadConfig().web?.publicUrl).toBeUndefined();
  });

  it('/server address shows and sets it', async () => {
    const said: string[] = [];
    const ui = { choose: async () => null, say: async (t: string) => { said.push(t); }, secret: async () => 'ok' as const };
    const ops = localServerOps({ offline: true });
    await runServerCommand('address https://phone.example.com', ops, ui);
    expect(said.at(-1)).toContain('Phone address saved: https://phone.example.com');
    await runServerCommand('address', ops, ui);
    expect(said.at(-1)).toContain('https://phone.example.com (saved)');
  });
});

describe('reachesMercury', () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  async function serve(answer: (url: URL) => { status: number; body: unknown }): Promise<string> {
    server?.close();
    server = createServer((req, res) => {
      const { status, body } = answer(new URL(req.url ?? '/', 'http://x'));
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('knows itself by the nonce, which works only while it asks', async () => {
    let seen = '';
    const url = await serve((u) => {
      seen = u.searchParams.get('probe') ?? '';
      return { status: 200, body: isLiveProbe(seen) ? { probe: seen } : { error: 'Not found' } };
    });
    expect(await reachesMercury(url)).toBe('mercury');
    expect(isLiveProbe(seen)).toBe(false);
  });

  it('tells another server and a dead address apart', async () => {
    const url = await serve(() => ({ status: 200, body: { ok: true } }));
    expect(await reachesMercury(url)).toBe('other');
    const remoteOff = await serve(() => ({ status: 403, body: { error: 'off', remoteOff: true } }));
    expect(await reachesMercury(remoteOff)).toBe('mercury');
    server?.close();
    expect(await reachesMercury(remoteOff, 500)).toBe('unreachable');
  });
});
