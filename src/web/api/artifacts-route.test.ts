import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

    // A file in Mercury's own folders: deleting deletes it.
    expect((await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(f)).toBe(false);
    expect((await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}/file`)).status).toBe(404);
  });

  it('a project file: only Mercury\'s copy goes', async () => {
    const project = mkdtempSync(join(tmpdir(), 'mercury-project-'));
    const f = join(project, 'report.pdf');
    writeFileSync(f, 'pdf');
    const a = artifactStore().add({ threadId: 't1', path: f, kind: 'pdf', tool: 'write_file' });
    const item = (await (await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}`)).json()) as { artifact: { owned: boolean } };
    expect(item.artifact.owned).toBe(false);
    const r = await (await artifacts.request(`http://127.0.0.1/api/artifacts/${a.id}`, { method: 'DELETE' })).json();
    expect(r).toMatchObject({ ok: true, removed: 1, keptOriginals: 1 });
    expect(existsSync(f)).toBe(true);
  });

  it('usage and bulk delete; never everything without saying so', async () => {
    for (const n of ['a.png', 'b.png', 'c.mp3']) writeFileSync(join(home, n), Buffer.alloc(1000, 1));
    artifactStore().add({ threadId: 't2', path: join(home, 'a.png'), kind: 'image' });
    artifactStore().add({ threadId: 't2', path: join(home, 'b.png'), kind: 'image' });
    artifactStore().add({ threadId: 't2', path: join(home, 'c.mp3'), kind: 'audio' });
    const usage = (await (await artifacts.request('http://127.0.0.1/api/artifacts/usage')).json()) as { count: number; bytes: number; byKind: Record<string, { count: number }> };
    expect(usage.count).toBe(3);
    expect(usage.bytes).toBe(3000);
    expect(usage.byKind.image.count).toBe(2);

    const post = (body: unknown) => artifacts.request('http://127.0.0.1/api/artifacts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect(await (await post({ kind: 'image' })).json()).toMatchObject({ removed: 2, freed: 2000 });
    expect(existsSync(join(home, 'a.png'))).toBe(false);
    expect(await (await post({ all: true })).json()).toMatchObject({ removed: 1 });
    expect(artifactStore().all()).toHaveLength(0);
  });
});
