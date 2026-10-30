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

const stop = () => chat.request('http://127.0.0.1/api/chat/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

/** The desktop stop button: the same stop the terminal's Esc and /stop use. */
describe('POST /api/chat/stop', () => {
  it('runs the stop routine and returns its note', async () => {
    const fn = vi.fn(async () => 'Foreground task stopped, locks released, task board cleared.');
    setStopCallback(fn);
    const res = await stop();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, note: 'Foreground task stopped, locks released, task board cleared.' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('reports a failure instead of pretending it stopped', async () => {
    setStopCallback(async () => { throw new Error('supervisor busy'); });
    const res = await stop();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'supervisor busy' });
  });
});
