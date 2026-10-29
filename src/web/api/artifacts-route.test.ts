import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-artifacts-route-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

import artifacts from './artifacts.js';
import { artifactStore } from '../../artifacts/store.js';

describe('artifacts API', () => {
  it('lists, serves (with ranges), exports and deletes; never exposes the stored path', async () => {
    const f = join(home, 'clip.mp4');
    writeFileSync(f, Buffer.from('0123456789abcdef'));
    const a = artifactStore().add({ threadId: 't1', path: f, kind: 'video' });
    const list = (await (await artifacts.request('http://127.0.0.1/api/artifacts?kind=video')).json()) as { items: unknown[]; counts: Record<string, number> };
    expect(list.items[0]).toMatchObject({ id: a.id, name: 'clip.mp4', kind: 'video', threadExists: false });
    expect(JSON.stringify(list)).not.toContain('storedPath');
    expect(list.counts).toMatchObject({ all: 1, video: 1 });

    const full = await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/file`);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(await full.text()).toBe('0123456789abcdef');
    const part = await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/file`, { headers: { Range: 'bytes=4-7' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('4567');

    const dest = join(home, 'saved-copy.mp4');
    const req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dest }) };
    const remote = await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/export`, req, { incoming: { socket: { remoteAddress: '10.0.0.7' } } });
    expect(remote.status).toBe(403);
    const exp = await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/export`, req, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(exp.status).toBe(200);
    expect(readFileSync(dest, 'utf-8')).toBe('0123456789abcdef');

    expect((await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(f)).toBe(true); // the original stays
    expect((await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/file`)).status).toBe(404);
  });
});
