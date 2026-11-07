import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-save-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { SessionRepository } from '../../sessions/repository.js';
import chat, { setSessionRepository } from './chat.js';

function threads() {
  const repo = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-save-sessions-')), autoMigrate: false });
  setSessionRepository(repo);
  const older = repo.create({ title: 'Older' });
  repo.appendMessage(older.id, { role: 'user', content: 'hi', timestamp: 1_000 });
  const newer = repo.create({ title: 'Newer' });
  // Clearly later than the first, so the order can't depend on the clock's resolution.
  repo.appendMessage(newer.id, { role: 'user', content: 'hello', timestamp: Date.now() + 60_000 });
  return { repo, older: older.id, newer: newer.id };
}

const save = (id: string, body: unknown) => chat.request(`http://127.0.0.1/api/chat/threads/${id}/save`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const list = async () => ((await (await chat.request('http://127.0.0.1/api/chat/threads')).json()) as { threads: Array<{ id: string; savedAt?: string }> }).threads;

/** Saved threads: a bookmark that survives restarts and doesn't reorder the list. */
describe('POST /api/chat/threads/:id/save', () => {
  it('saves and unsaves a thread', async () => {
    const { older } = threads();
    const res = await save(older, { saved: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: older, saved: true });
    expect((await list()).find((t) => t.id === older)?.savedAt).toEqual(expect.any(String));

    expect(await (await save(older, { saved: false })).json()).toMatchObject({ saved: false, savedAt: null });
    expect((await list()).find((t) => t.id === older)?.savedAt).toBeUndefined();
  });

  it('keeps the thread where it was in the list', async () => {
    const { repo, older, newer } = threads();
    const before = repo.get(older).updatedAt;
    await save(older, { saved: true });
    expect(repo.get(older).updatedAt).toBe(before);
    expect((await list()).map((t) => t.id)).toEqual([newer, older]);
  });

  it('survives a fresh read from disk', async () => {
    const { repo, older } = threads();
    await save(older, { saved: true });
    const again = new SessionRepository({ rootDir: (repo as unknown as { rootDir: string }).rootDir, autoMigrate: false });
    expect(again.get(older).savedAt).toEqual(expect.any(Number));
  });

  it('needs a yes or no, and a real thread', async () => {
    const { older } = threads();
    expect((await save(older, {})).status).toBe(400);
    expect((await save('nope', { saved: true })).status).toBe(404);
  });
});
