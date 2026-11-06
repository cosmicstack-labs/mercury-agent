import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-recall-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import { SessionRepository } from '../../sessions/repository.js';
import { createSessionHistoryTools } from '../../capabilities/system/session-history.js';
import chat, { setSessionRepository } from './chat.js';

describe('web/desktop chat history and agent recall share canonical persistence', () => {
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reopens the same source dialogue through the shared chat API and recall tools after restart', async () => {
    const repository = new SessionRepository();
    setSessionRepository(repository);
    const created = await chat.request('http://localhost/api/chat/threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Planning source' }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    // Both clients send through /api/chat/send; the Agent owns these writes.
    const original = repository.appendMessage(id, { role: 'user', content: 'Project marker: indigo-413' });
    repository.appendMessage(id, { role: 'assistant', content: 'The review is on Friday.', reasoning: 'hidden-reasoning' });
    const restarted = new SessionRepository();
    setSessionRepository(restarted);
    const tools = createSessionHistoryTools(restarted, () => true);
    const options = { toolCallId: 'recall', messages: [] };
    const found = await tools.search_sessions.execute!({ query: 'indigo-413', offset: 0, limit: 5, include_archived: false }, options);
    expect(found).toMatchObject({ results: [{ id, excerpt: { id: original.id, sequence: original.sequence } }] });

    // Web and desktop use these same two endpoints and canonical IDs.
    const listed = await (await chat.request('http://localhost/api/chat/threads')).json();
    expect(listed).toMatchObject({ threads: [{ id, title: 'Planning source' }] });
    const opened = await (await chat.request(`http://localhost/api/chat/threads/${encodeURIComponent(id)}`)).json() as { messages: Array<{ id: string; content: string; sequence: number }> };
    const read = await tools.read_session.execute!({ session_id: id, limit: 20, include_archived: false }, options);
    expect(read).toMatchObject({ session: { id }, messages: opened.messages.map(({ id, content, sequence }) => ({ id, content, sequence })), next_cursor: null });
    expect(JSON.stringify(read)).not.toContain('hidden-reasoning');
    expect(restarted.get(id).messages).toHaveLength(2);
  });
});
