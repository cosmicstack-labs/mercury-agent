import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-undo-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { SessionRepository } from '../../sessions/repository.js';
import chat, { setSessionBusyLookup, setSessionRepository } from './chat.js';

function conversation() {
  const repo = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-undo-sessions-')), autoMigrate: false });
  setSessionRepository(repo);
  const s = repo.create({ title: 'Undo test' });
  const first = repo.appendMessage(s.id, { role: 'user', content: 'What is the weather?' });
  repo.appendMessage(s.id, { role: 'assistant', content: 'Sunny.' });
  const last = repo.appendMessage(s.id, { role: 'user', content: 'And tomorow?', metadata: { attachments: [{ name: 'a.png' }] } });
  repo.appendMessage(s.id, { role: 'assistant', kind: 'tool-call', content: 'searched' });
  repo.appendMessage(s.id, { role: 'assistant', content: 'Rain.' });
  return { repo, id: s.id, first, last };
}

const undo = (id: string, messageId?: string) => chat.request(`http://127.0.0.1/api/chat/threads/${id}/undo`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageId ? { messageId } : {}),
});

afterEach(() => setSessionBusyLookup(null));

/** Undo: take back your last message and the reply, so Mercury forgets them too. */
describe('POST /api/chat/threads/:id/undo', () => {
  it('removes your last message and everything after it, and hands its text back', async () => {
    const { repo, id, last } = conversation();
    const res = await undo(id, last.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, content: 'And tomorow?', attachments: [{ name: 'a.png' }], removed: 3 });
    expect(repo.get(id).messages.map((m) => m.content)).toEqual(['What is the weather?', 'Sunny.']);
  });

  it('only the last message can be undone', async () => {
    const { repo, id, first } = conversation();
    const res = await undo(id, first.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ notLast: true });
    expect(repo.get(id).messages).toHaveLength(5);
  });

  it('a message shown before it was saved is matched by its text', async () => {
    const { repo, id } = conversation();
    const by = (content: string) => chat.request(`http://127.0.0.1/api/chat/threads/${id}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    expect((await by('What is the weather?')).status).toBe(409);
    expect((await by('And tomorow?')).status).toBe(200);
    expect(repo.get(id).messages).toHaveLength(2);
  });

  it('waits for a running turn: stop it first', async () => {
    const { repo, id, last } = conversation();
    setSessionBusyLookup((sessionId) => sessionId === id);
    const res = await undo(id, last.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ busy: true });
    expect(repo.get(id).messages).toHaveLength(5);
  });
});
