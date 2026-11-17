import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-preview-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { SessionRepository } from '../../sessions/repository.js';
import chat, { setSessionRepository } from './chat.js';

type Row = { id: string; preview?: string; lastRole?: string; messages: unknown[] };

function repo() {
  const r = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-preview-sessions-')), autoMigrate: false });
  setSessionRepository(r);
  return r;
}
const list = async () => ((await (await chat.request('http://127.0.0.1/api/chat/threads')).json()) as { threads: Row[] }).threads;
const row = async (id: string) => (await list()).find((t) => t.id === id)!;

/** The list's one-line preview of each chat's last message (Mercury iOS shows it under the title). */
describe('GET /api/chat/threads preview', () => {
  it("shows the last reply as one plain line, without the messages", async () => {
    const r = repo();
    const s = r.create({ title: 'Landing page' });
    r.appendMessage(s.id, { role: 'user', content: 'What changed?' });
    r.appendMessage(s.id, { role: 'assistant', content: '## Landing page\n\nThe **deploy** is ready. See [the notes](https://x.test) and `plans.json`.\n\n- Hero\n- Pricing' });
    r.appendMessage(s.id, { role: 'assistant', kind: 'tool-call', content: 'run_command npm test' });
    r.appendMessage(s.id, { role: 'system', content: 'Something went wrong' });
    const t = await row(s.id);
    expect(t.messages).toEqual([]);
    expect(t).toMatchObject({ preview: 'Landing page The deploy is ready. See the notes and plans.json. Hero Pricing', lastRole: 'assistant' });
  });

  it('says who wrote last, and cuts long text', async () => {
    const r = repo();
    const s = r.create();
    r.appendMessage(s.id, { role: 'assistant', content: 'Hello' });
    r.appendMessage(s.id, { role: 'user', content: `  ${'word '.repeat(60)}\n\n` });
    const t = await row(s.id);
    expect(t.lastRole).toBe('user');
    expect([...t.preview!].length).toBeLessThanOrEqual(140);
    expect(t.preview!.endsWith('…')).toBe(true);
    expect(t.preview).not.toMatch(/\s\s/);
  });

  it('names the files of a message that was only files', async () => {
    const r = repo();
    const s = r.create();
    r.appendMessage(s.id, {
      role: 'user', content: '(Attached: brief.md, pricing.pdf)',
      metadata: { attachments: [{ name: 'brief.md', kind: 'document', ref: 'a' }, { name: 'pricing.pdf', kind: 'pdf', ref: 'b' }] },
    });
    expect(await row(s.id)).toMatchObject({ preview: 'brief.md, pricing.pdf', lastRole: 'user' });
  });

  it('leaves the preview out of a chat with nothing to show', async () => {
    const r = repo();
    const s = r.create();
    r.appendMessage(s.id, { role: 'assistant', content: '   ' });
    const t = await row(s.id);
    expect(t.preview).toBeUndefined();
    expect(t.lastRole).toBeUndefined();
  });

  it('keeps one thread unchanged: messages and no preview', async () => {
    const r = repo();
    const s = r.create();
    r.appendMessage(s.id, { role: 'user', content: 'hi' });
    const one = (await (await chat.request(`http://127.0.0.1/api/chat/threads/${s.id}`)).json()) as Row;
    expect(one.messages).toHaveLength(1);
    expect(one.preview).toBeUndefined();
  });
});
