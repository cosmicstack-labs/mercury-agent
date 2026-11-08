import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { IsolatedBrowserReader } from './reader.js';
import { BrowserPipe } from './pipe.js';
import { browserUrl, requestPublicResource, type BrowserTransport } from './public-request.js';

const launched = vi.hoisted(() => [] as import('node:child_process').ChildProcess[]);
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    launched.push(child);
    return child;
  } };
});

// Explicit opt-in: the normal suite does not require or install a browser.
// CI runs this file separately on Linux and Windows with an already installed
// Chrome/Edge. Transport injection is confined to this test; no production flag
// can weaken DNS validation or enable access to a private network.
describe.skipIf(process.env.MERCURY_TEST_BROWSER !== '1')('installed browser against local public-origin fixtures', () => {
  let server: Server;
  let origin: string;
  const hits: string[] = [];
  let transportedBytes = 0;
  const readers: IsolatedBrowserReader[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/slow') return; // cancellation must close this request.
      if (req.url === '/redirect-private') { res.writeHead(302, { Location: 'http://127.0.0.1/secret' }).end(); return; }
      if (req.url === '/redirect-public') { res.writeHead(302, { Location: '/a' }).end(); return; }
      if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename=secret.html' }).end('do not save'); return; }
      if (req.url === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }).end('body { background: #eef; } h1 { color: #246; }'); return; }
      if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('x'.repeat(2_000_001)); return; }
      if (req.url === '/large-image') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(`<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(1_999_800)}--><rect width="20" height="20" fill="green"/></svg>`); return; }
      const body = req.url === '/a' ? '<h1>Session A public page</h1><a href="/b">Next page</a>'
        : req.url === '/b' ? '<h1>Session B public page</h1>'
        : req.url === '/budget' ? '<h1>Resource budget fixture</h1>' + Array.from({ length: 39 }, (_, i) => `<img src="/large-image?i=${i}">`).join('')
        : `<h1>Safe static content</h1><link rel="stylesheet" href="/style.css">
          <script>document.body.innerHTML='SCRIPT EXECUTED';fetch('/mutation',{method:'POST'});new WebSocket('ws://127.0.0.1/private');</script>
          <iframe src="file:///etc/passwd"></iframe><iframe src="${origin}/private-frame"></iframe>
          <img src="${origin}/private-image"><img src="http://169.254.169.254/metadata">
          <img src="https://127.0.0.1/private-tls"><form method="post" action="/mutation"><input type="password" value="PAGE-PASSWORD"><button>Send</button></form>
          <meta http-equiv="refresh" content="0;url=file:///etc/passwd">`;
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'token=DO-NOT-SHARE; Path=/' });
      res.end(`<!doctype html><title>Isolated reader fixture</title>${body}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.closeAll()));
    for (const child of launched.splice(0)) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const profile = child.spawnargs.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      if (profile) await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
      if (profile && process.platform === 'win32') await expect(stat(dirname(profile))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    hits.length = 0;
    transportedBytes = 0;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const transport: BrowserTransport = async (url, signal, budget) => {
    browserUrl(url.href);
    if (url.hostname !== 'fixture.public.example') return requestPublicResource(url, signal, budget);
    const response = await fetch(origin + url.pathname, { redirect: 'manual', signal });
    const chunks: Buffer[] = [];
    for await (const part of response.body!) {
      budget.consume(part.length);
      transportedBytes += part.length;
      chunks.push(Buffer.from(part));
    }
    const body = Buffer.concat(chunks);
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  };
  function reader(options: { idleMs?: number } = {}) {
    const result = new IsolatedBrowserReader({ transport, ...options });
    readers.push(result);
    return result;
  }

  it('renders an approved HTTPS origin through the guard, with scripts, private subresources, frames and credentials disabled', async () => {
    const result = await reader().run('session-a', 'navigate', 'https://fixture.public.example/');
    expect(result?.text).toContain('Safe static content');
    expect(result?.text).not.toMatch(/SCRIPT EXECUTED|PAGE-PASSWORD|root:x:/);
    expect(result?.image.startsWith('/9j/')).toBe(true);
    expect(hits).toContain('/style.css');
    expect(hits.some((url) => /private|metadata|mutation/.test(url))).toBe(false);
    if (process.env.MERCURY_BROWSER_EVIDENCE_DIR) {
      await mkdir(process.env.MERCURY_BROWSER_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.MERCURY_BROWSER_EVIDENCE_DIR, 'isolated-reader.jpg'), Buffer.from(result!.image, 'base64'));
      await writeFile(join(process.env.MERCURY_BROWSER_EVIDENCE_DIR, 'snapshot.txt'), result!.text);
    }
  }, 45_000); // Includes the bounded 30-second cold-browser startup allowance.

  it('isolates two sessions, enforces capacity and removes profiles on explicit close', async () => {
    const browser = reader();
    await browser.run('session-a', 'navigate', 'https://fixture.public.example/a');
    await browser.run('session-b', 'navigate', 'https://fixture.public.example/b');
    await expect(browser.run('session-c', 'navigate', 'https://fixture.public.example/a')).rejects.toThrow('Two isolated');
    expect((await browser.run('session-a', 'snapshot'))?.text).toContain('Session A public page');
    expect((await browser.run('session-b', 'snapshot'))?.text).toContain('Session B public page');
    await browser.run('session-a', 'close');
    await expect(browser.run('session-a', 'snapshot')).rejects.toThrow('No isolated page');
    await browser.run('session-c', 'navigate', 'https://fixture.public.example/a');
  }, 30_000);

  it('follows bounded public redirects but blocks private redirects and downloads without writing files', async () => {
    const browser = reader();
    expect((await browser.run('session-a', 'navigate', 'https://fixture.public.example/redirect-public'))?.text).toContain('Session A public page');
    await expect(browser.run('session-a', 'navigate', 'https://fixture.public.example/redirect-private')).rejects.toThrow(/private|internal/);
    await expect(browser.run('session-a', 'navigate', 'https://fixture.public.example/download')).rejects.toThrow('download');
    expect(hits).not.toContain('/secret');
  }, 30_000);

  it('rejects excessive response bodies and clears their browser session', async () => {
    const browser = reader();
    await expect(browser.run('session-a', 'navigate', 'https://fixture.public.example/huge')).rejects.toThrow('exceeds 2 MB');
    await expect(browser.run('session-a', 'snapshot')).rejects.toThrow('No isolated page');
  }, 30_000);

  it('bounds total transported page bytes even when many individually valid resources race', async () => {
    const result = await reader().run('session-a', 'navigate', 'https://fixture.public.example/budget');
    expect(result?.text).toContain('Resource budget fixture');
    expect(hits.filter((path) => path === '/large-image').length).toBeGreaterThan(0);
    expect(hits.filter((path) => path === '/large-image').length).toBeLessThanOrEqual(8);
    expect(transportedBytes).toBeLessThanOrEqual(8_000_000);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('retains capacity when termination cannot be confirmed, then permits cleanup retry', async () => {
    const browser = reader();
    await browser.run('session-a', 'navigate', 'https://fixture.public.example/a');
    await browser.run('session-b', 'navigate', 'https://fixture.public.example/b');
    const send = BrowserPipe.prototype.send;
    const kill = process.kill;
    // Fault injection only: leave these owned fixture processes alive despite
    // both shutdown attempts, then restore real cleanup in finally.
    const sendSpy = vi.spyOn(BrowserPipe.prototype, 'send').mockImplementation(function (this: BrowserPipe, method: string, params?: Record<string, unknown>, sessionId?: string) {
      return method === 'Browser.close' ? Promise.resolve({}) : send.call(this, method, params, sessionId);
    } as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGKILL' && launched.some((child) => child.pid === -pid)) return true;
      return kill(pid, signal);
    });
    try {
      await expect(browser.run('session-a', 'close')).rejects.toThrow('process is still running');
      await expect(browser.run('session-c', 'navigate', 'https://fixture.public.example/a')).rejects.toThrow('Two isolated');
    } finally {
      sendSpy.mockRestore();
      killSpy.mockRestore();
      await browser.closeAll();
    }
    await expect(browser.run('session-a', 'snapshot')).rejects.toThrow('No isolated page');
  }, 30_000);

  it('cancels an in-flight navigation, releases the session and deletes temporary profiles', async () => {
    const browser = reader();
    const controller = new AbortController();
    const run = browser.run('session-a', 'navigate', 'https://fixture.public.example/slow', controller.signal);
    const rejection = expect(run).rejects.toThrow();
    await expect.poll(() => hits.includes('/slow'), { timeout: 10_000 }).toBe(true);
    controller.abort();
    await rejection;
    await expect(browser.run('session-a', 'snapshot')).rejects.toThrow('No isolated page');
  }, 30_000);

  it('cancels a blocked startup without waiting for the longer bootstrap deadline', async () => {
    const browser = reader();
    const controller = new AbortController();
    let started!: () => void;
    const startup = new Promise<void>((resolve) => { started = resolve; });
    const send = BrowserPipe.prototype.send;
    const spy = vi.spyOn(BrowserPipe.prototype, 'send').mockImplementation(function (this: BrowserPipe, ...args: Parameters<BrowserPipe['send']>) {
      const pending = send.apply(this, args);
      if (args[0] === 'Target.getTargets') {
        // Hold the real browser's reply in its owned pipe. Cancellation must
        // reject the queued request and close the process, not wait 30 seconds.
        (launched.at(-1)!.stdio[4] as Readable).pause();
        started();
      }
      return pending;
    } as never);
    try {
      const pending = browser.run('cancel-startup', 'navigate', 'https://fixture.public.example/a', controller.signal);
      const rejection = expect(pending).rejects.toThrow('closed');
      await startup;
      controller.abort();
      await rejection;
      await expect(browser.run('cancel-startup', 'snapshot')).rejects.toThrow('No isolated page');
    } finally { spy.mockRestore(); }
  }, 10_000);

  it('expires idle sessions', async () => {
    const browser = reader({ idleMs: 100 });
    await browser.run('session-a', 'navigate', 'https://fixture.public.example/a');
    await expect.poll(async () => {
      try { await browser.run('session-a', 'snapshot'); return false; } catch { return true; }
    }, { timeout: 10_000, interval: 500 }).toBe(true);
  }, 30_000);
});
