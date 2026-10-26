import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGuardedFetch, PinTable } from './ssrf.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/echo' }).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('createGuardedFetch', () => {
  it('blocks loopback targets by default', async () => {
    await expect(createGuardedFetch()(`${base}/echo`)).rejects.toThrow(
      /private\/internal address \(SSRF protection\)\. Set MERCURY_ALLOW_PRIVATE_FETCH=1/,
    );
  });

  it('uses the caller hint when a target is blocked', async () => {
    await expect(createGuardedFetch({ privateHint: 'Use the server setting.' })(`${base}/echo`)).rejects.toThrow(
      'Blocked: 127.0.0.1 is a private/internal address (SSRF protection). Use the server setting.',
    );
  });

  it('forwards method, body and headers when private targets are allowed', async () => {
    const res = await createGuardedFetch({ allowPrivate: true })(new URL(`${base}/echo`), {
      method: 'POST',
      body: '{"x":1}',
      headers: { authorization: 'Bearer abc' },
    });
    expect(await res.json()).toEqual({ method: 'POST', body: '{"x":1}', auth: 'Bearer abc' });
  });

  it('returns redirects instead of following them', async () => {
    const res = await createGuardedFetch({ allowPrivate: true })(`${base}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/echo');
  });

  it('still rejects non-http schemes', async () => {
    await expect(createGuardedFetch({ allowPrivate: true })('file:///etc/passwd')).rejects.toThrow(/Blocked scheme/);
    // allowPrivate opens loopback and the LAN, never cloud metadata.
    await expect(createGuardedFetch({ allowPrivate: true })('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/link-local/);
    await expect(createGuardedFetch({ allowPrivate: true })('http://[fe80::1]/')).rejects.toThrow(/link-local/);
    await expect(createGuardedFetch({ allowPrivate: true })('http://metadata.google.internal/')).rejects.toThrow(/metadata/);
  });
});

describe('PinTable', () => {
  it('keeps a host pinned until every request using it has finished', () => {
    const pins = new PinTable();
    pins.acquire('example.com', { address: '93.184.216.34', family: 4 });
    pins.acquire('example.com', { address: '93.184.216.34', family: 4 });
    pins.release('example.com');
    expect(pins.get('example.com')).toEqual({ address: '93.184.216.34', family: 4 });
    pins.release('example.com');
    expect(pins.get('example.com')).toBeUndefined();
    pins.release('example.com');
    expect(pins.get('example.com')).toBeUndefined();
  });

  it('uses the latest validated address while requests overlap', () => {
    const pins = new PinTable();
    pins.acquire('example.com', { address: '93.184.216.34', family: 4 });
    pins.acquire('example.com', { address: '93.184.216.35', family: 4 });
    expect(pins.get('example.com')).toEqual({ address: '93.184.216.35', family: 4 });
    pins.release('example.com');
    expect(pins.get('example.com')).toEqual({ address: '93.184.216.35', family: 4 });
  });
});
