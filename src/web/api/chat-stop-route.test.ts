import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-stop-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import chat, { setStopCallback } from './chat.js';

const stop = (body: unknown = { sessionId: 'session-a' }) => chat.request('http://127.0.0.1/api/chat/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A chat stop can never silently become a global stop. */
describe('POST /api/chat/stop', () => {
  it('runs the stop routine and returns its note', async () => {
    const fn = vi.fn(async () => 'Foreground task stopped, locks released, task board cleared.');
    setStopCallback(fn);
    const res = await stop();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, note: 'Foreground task stopped, locks released, task board cleared.' });
    expect(fn).toHaveBeenCalledExactlyOnceWith('session-a');
  });

  it.each([{}, { sessionId: null }, { sessionId: '' }, { sessionId: 'x'.repeat(201) }])('rejects an unscoped or invalid stop %j', async (body) => {
    const fn = vi.fn(async () => 'stopped');
    setStopCallback(fn);
    expect((await stop(body)).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports a failure instead of pretending it stopped', async () => {
    setStopCallback(async () => { throw new Error('supervisor busy'); });
    const res = await stop();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'supervisor busy' });
  });
});
