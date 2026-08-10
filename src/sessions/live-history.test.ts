import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConversationHistoryPayload } from './live-history.js';

const AGENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
import { SessionRepository } from './repository.js';

function fixture() {
  return new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-history-')), autoMigrate: false });
}

describe('buildConversationHistoryPayload', () => {
  it('paginates active summaries in updated order without messages', () => {
    vi.useFakeTimers();
    const repository = fixture();
    vi.setSystemTime(1_000);
    const first = repository.create({ alias: 'first-session' });
    vi.setSystemTime(2_000);
    const second = repository.create({ alias: 'second-session' });
    vi.setSystemTime(3_000);
    const third = repository.create({ alias: 'third-session' });
    repository.appendMessage(third.id, { role: 'user', content: 'not in summary' });
    repository.archive(first.id);
    repository.markDeleted(second.id);

    vi.setSystemTime(4_000);
    const fourth = repository.create({ alias: 'fourth-session' });
    const fifth = repository.create({ alias: 'fifth-session' });
    const page1 = buildConversationHistoryPayload(repository, { requestId: 'request-1', limit: 2 }, AGENT_ID);
    if (!page1.sessions) throw new Error('Expected a conversation history list');

    expect(page1.sessions.map((session) => session.id)).toEqual([fourth.id, fifth.id].sort());
    expect(page1.sessions[0]).toEqual(expect.objectContaining({
      alias: expect.any(String), status: 'active', revision: 1, createdAt: expect.stringMatching(/Z$/), updatedAt: expect.stringMatching(/Z$/),
    }));
    expect(page1.sessions[0]).not.toHaveProperty('messages');
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = buildConversationHistoryPayload(repository, { requestId: 'request-1', cursor: page1.nextCursor!, limit: 2 }, AGENT_ID);
    if (!page2.sessions) throw new Error('Expected a conversation history list');
    expect(page2.sessions.map((session) => session.id)).toEqual([third.id]);
    expect(page2.nextCursor).toBeNull();
    vi.useRealTimers();
  });

  it('serializes full detail with ordered messages and rejects deleted sessions', () => {
    const repository = fixture();
    const session = repository.create({ alias: 'detail-session' });
    repository.appendMessage(session.id, { role: 'assistant', content: 'second', timestamp: 2_000 });
    repository.appendMessage(session.id, { role: 'user', content: 'first', timestamp: 1_000 });

    const detail = buildConversationHistoryPayload(repository, { requestId: 'detail-1', sessionId: session.id }, AGENT_ID);
    if (!detail.messages || !detail.session) throw new Error('Expected conversation history detail');
    expect(detail).toMatchObject({ requestId: 'detail-1', session: { id: session.id, alias: session.alias, status: 'active' } });
    expect(detail.messages.map((message) => message.content)).toEqual(['second', 'first']);
    expect(detail.messages.every((message) => typeof message.timestamp === 'string' && message.timestamp.endsWith('Z'))).toBe(true);
    expect(detail.session).not.toHaveProperty('messages');

    repository.markDeleted(session.id);
    expect(() => buildConversationHistoryPayload(repository, { requestId: 'detail-2', sessionId: session.id }, AGENT_ID)).toThrow(/not found/);
  });

  it('caps list limits at 50 and rejects malformed cursors', () => {
    const repository = fixture();
    for (let index = 0; index < 51; index++) repository.create();
    const result = buildConversationHistoryPayload(repository, { requestId: 'limit', limit: 100 }, AGENT_ID);
    expect('sessions' in result && result.sessions).toHaveLength(50);
    expect(() => buildConversationHistoryPayload(repository, { requestId: 'bad', cursor: 'not-a-cursor' }, AGENT_ID)).toThrow(/Invalid conversation history cursor/);
  });
});
