import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types.js';
import { buildSessionSyncBatches, CloudSessionSynchronizer } from './cloud-sync.js';
import { SessionRepository } from './repository.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeSession(index: number, messageCount: number): Session {
  const id = `${index.toString(16).padStart(8, '0')}-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
  return {
    id,
    shortId: id.slice(0, 8),
    alias: `session-${index}`,
    title: `Session ${index}`,
    titleSource: 'generated',
    createdAt: index,
    updatedAt: index,
    status: 'active',
    revision: 1,
    bindings: [],
    messages: Array.from({ length: messageCount }, (_, sequence) => ({
      id: `${sequence.toString(16).padStart(8, '0')}-2222-4222-8222-${sequence.toString(16).padStart(12, '0')}`,
      sessionId: id,
      role: 'user' as const,
      kind: 'message' as const,
      content: String(sequence),
      timestamp: sequence,
      sequence: sequence + 1,
    })),
  };
}

describe('buildSessionSyncBatches', () => {
  it('serializes canonical timestamps and respects cloud batch limits', () => {
    const first = makeSession(1, 5_001);
    (first.messages[0] as any).reasoning = [{ type: 'reasoning', text: 'legacy shape' }];
    const batches = buildSessionSyncBatches('agent-1', [first, ...Array.from({ length: 101 }, (_, index) => makeSession(index + 2, 0))]);
    expect(batches.every((batch) => batch.sessions.length <= 100 && batch.messages.length <= 5_000)).toBe(true);
    expect(batches.flatMap((batch) => batch.messages)).toHaveLength(5_001);
    expect(new Set(batches.flatMap((batch) => batch.sessions.map((session) => session.id))).size).toBe(102);
    expect(batches[0].sessions[0].agentId).toBe('agent-1');
    expect(batches[0].sessions[0].createdAt).toMatch(/^1970-/);
    expect(batches[0].sessions[0]).not.toHaveProperty('shortId');
    expect(batches.flatMap((batch) => batch.messages)[0]).not.toHaveProperty('agentId');
    expect(batches.flatMap((batch) => batch.messages)[0].reasoning).toBe('[{"type":"reasoning","text":"legacy shape"}]');
    expect(buildSessionSyncBatches('agent-1', [])).toEqual([]);
  });

  it('syncs in the background after debounce and retries transient failures', async () => {
    vi.useFakeTimers();
    const repository = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-sync-')), autoMigrate: false });
    const session = repository.create();
    repository.appendMessage(session.id, { role: 'user', content: 'hello', externalMessageId: 'local-only-id' });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const synchronizer = new CloudSessionSynchronizer(repository, () => ({
      apiUrl: 'https://api.example.com',
      agentId: 'aaaaaaaa-1111-4111-8111-111111111111',
      token: 'token',
    }), 50);

    expect(synchronizer.isEnabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    synchronizer.start();
    expect(synchronizer.isEnabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    repository.appendMessage(session.id, { role: 'assistant', content: 'hi' });
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(Object.keys(body).sort()).toEqual(['messages', 'sessions']);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).not.toHaveProperty('externalMessageId');
    synchronizer.stop();
    expect(synchronizer.isEnabled()).toBe(false);
    repository.appendMessage(session.id, { role: 'assistant', content: 'stays local' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
