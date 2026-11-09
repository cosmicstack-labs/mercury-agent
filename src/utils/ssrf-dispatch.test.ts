import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Exercise the real guardedFetch transport against a local server without
// public network access. Only this isolated test module enables the existing
// private-fetch override; production validation is covered by ssrf.test.ts.
const originalPrivateFetch = vi.hoisted(() => {
  const previous = process.env.MERCURY_ALLOW_PRIVATE_FETCH;
  process.env.MERCURY_ALLOW_PRIVATE_FETCH = '1';
  return previous;
});
vi.mock('node:dns', () => ({
  lookup: vi.fn((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }),
}));

import { lookup } from 'node:dns';
import { createGuardedFetch, guardedFetch } from './ssrf.js';

let server: Server;
let base: string;
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') return void res.writeHead(302, { location: '/echo' }).end();
    if (req.url === '/private') return void res.writeHead(302, { location: 'http://127.0.0.1/private' }).end();
    if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/pending') return; // cancelled by the test's AbortSignal
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk');
      return; // cancelled through the response body
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      method: req.method, body, auth: req.headers.authorization ?? null, contentType: req.headers['content-type'] ?? null,
    })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://mercury-fixture.test:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (originalPrivateFetch === undefined) delete process.env.MERCURY_ALLOW_PRIVATE_FETCH;
  else process.env.MERCURY_ALLOW_PRIVATE_FETCH = originalPrivateFetch;
});

describe('guarded Fetch transport compatibility', () => {
  it('follows validated redirects in the web-content fetch path', async () => {
    const response = await guardedFetch(`${base}/redirect`, new AbortController().signal, { authorization: 'Bearer fixture' });
    expect(response.url).toBe(`${base}/echo`);
    expect(await response.json()).toMatchObject({ method: 'GET', auth: 'Bearer fixture' });
  });

  it('validates each redirect and retains the redirect bound', async () => {
    await expect(guardedFetch(`${base}/private`, new AbortController().signal)).rejects.toThrow(/private\/internal/);
    await expect(guardedFetch(`${base}/loop`, new AbortController().signal)).rejects.toThrow('too many redirects');
  });

  it('pins the validated hostname without a second DNS lookup', async () => {
    vi.mocked(lookup).mockClear();
    const url = base.replace('mercury-fixture.test', 'pinned-fixture.test');
    const response = await createGuardedFetch({ allowPrivate: true })(`${url}/echo`);
    expect(await response.json()).toMatchObject({ method: 'GET' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('pinned-fixture.test', { all: true }, expect.any(Function));
  });

  it('accepts native Headers and FormData without losing multipart fields', async () => {
    const form = new FormData();
    form.append('note', 'multipart fixture');
    form.append('file', new Blob(['file fixture'], { type: 'text/plain' }), 'fixture.txt');
    const response = await createGuardedFetch({ allowPrivate: true })(`${base}/echo`, {
      method: 'POST', headers: new Headers({ authorization: 'Bearer fixture' }), body: form,
    });
    const output = await response.json() as { body: string; contentType: string; auth: string };
    expect(output.auth).toBe('Bearer fixture');
    expect(output.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(output.body).toContain('name="note"');
    expect(output.body).toContain('multipart fixture');
    expect(output.body).toContain('filename="fixture.txt"');
    expect(output.body).toContain('file fixture');
  });

  it('forwards a native streaming request body', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed input')); controller.close(); } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    const response = await createGuardedFetch({ allowPrivate: true })(`${base}/echo`, init);
    expect(await response.json()).toMatchObject({ body: 'streamed input' });
  });

  it('rejects pre-aborted requests without sending them', async () => {
    const before = requests;
    const controller = new AbortController();
    controller.abort();
    await expect(createGuardedFetch({ allowPrivate: true })(`${base}/echo`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(before);
  });

  it('aborts an in-flight request before headers arrive', async () => {
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => server.once('request', () => resolve()));
    const pending = createGuardedFetch({ allowPrivate: true })(`${base}/pending`, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
  });

  it('cancels an unread streaming response body and releases the connection', async () => {
    const closed = new Promise<void>((resolve) => server.once('request', (_req, res) => res.once('close', resolve)));
    const response = await createGuardedFetch({ allowPrivate: true })(`${base}/stream`);
    await response.body!.cancel();
    await closed;
    const next = await createGuardedFetch({ allowPrivate: true })(`${base}/echo`);
    expect(await next.json()).toMatchObject({ method: 'GET' });
  });
});
