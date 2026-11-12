import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-rename-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { SessionRepository } from '../../sessions/repository.js';
import chat, { setSessionRepository } from './chat.js';

const rename = (id: string, body: unknown) => chat.request(`http://127.0.0.1/api/chat/threads/${id}/title`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('PUT /api/chat/threads/:id/title', () => {
  let root: string;
  let repo: SessionRepository;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-rename-sessions-'));
    repo = new SessionRepository({ rootDir: root, autoMigrate: false });
    setSessionRepository(repo);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('persists an owner title, preserves history and order, and returns it on reload', async () => {
    const session = repo.create();
    repo.appendMessage(session.id, { role: 'user', content: 'A first message', timestamp: 1000 });
    const before = repo.get(session.id);
    const response = await rename(session.id, { title: ' 旅行  計画\n😀 ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: session.id, title: '旅行 計画 😀' });
    const reloaded = new SessionRepository({ rootDir: root, autoMigrate: false });
    expect(reloaded.get(session.id)).toMatchObject({ title: '旅行 計画 😀', titleSource: 'user', updatedAt: before.updatedAt, messages: before.messages, revision: before.revision + 1 });
    setSessionRepository(reloaded);
    const list = await (await chat.request('http://127.0.0.1/api/chat/threads')).json() as { threads: Array<{ title: string }> };
    expect(list.threads[0].title).toBe('旅行 計画 😀');
    const detail = await (await chat.request(`http://127.0.0.1/api/chat/threads/${session.id}`)).json();
    expect(detail).toMatchObject({ title: '旅行 計画 😀', messages: [{ content: 'A first message' }] });
  });

  it('accepts 120 Unicode code points and rejects 121 without silently truncating', async () => {
    const session = repo.create();
    expect((await rename(session.id, { title: '😀'.repeat(120) })).status).toBe(200);
    expect((await rename(session.id, { title: '😀'.repeat(121) })).status).toBe(400);
    expect(repo.get(session.id).title).toBe('😀'.repeat(120));
  });

  it.each([null, {}, { title: 1 }, { title: '' }, { title: ' \n\t ' }, { title: 'bad\0title' }, { title: '\u0080' }, { title: '\ud800' }])('rejects invalid input without changing the session: %j', async body => {
    const session = repo.create({ title: 'Original' });
    expect((await rename(session.id, body)).status).toBe(400);
    expect(repo.get(session.id).title).toBe('Original');
    expect(repo.get(session.id).revision).toBe(session.revision);
  });

  it('returns 404 for unknown sessions and an honest 500 for persistence failures', async () => {
    expect((await rename('missing', { title: 'Name' })).status).toBe(404);
    const session = repo.create();
    vi.spyOn(repo, 'updateTitle').mockImplementation(() => { throw new Error('disk full'); });
    const response = await rename(session.id, { title: 'Name' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not save the chat name. Please try again.' });
  });
});
