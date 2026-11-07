import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Tool } from 'ai';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-recall-home-'));
  process.env.MERCURY_HOME = root;
  return root;
});

import { SessionRepository } from '../../sessions/repository.js';
import { CapabilityRegistry } from '../registry.js';
import { makeContext } from '../permission-context.js';
import { createSessionHistoryTools, SESSION_RECALL_OUTPUT_LIMIT } from './session-history.js';

interface SearchPage {
  results: Array<{ id: string; title: string; excerpt: { id: string; content: string; sequence: number } | null }>;
  next_offset: number | null;
  skipped_sessions: number;
  scanned_sessions: number;
  partial: boolean;
}
interface ReadPage {
  messages: Array<{ id: string; content: string; sequence: number; offset: number; truncated: boolean }>;
  next_cursor: string | null;
}

async function invoke<T>(instance: Tool, input: Record<string, unknown>): Promise<T> {
  return await instance.execute!(input, { toolCallId: 'test', messages: [] }) as T;
}

describe('saved session recall', () => {
  let root: string;
  let repository: SessionRepository;
  let tools: ReturnType<typeof createSessionHistoryTools>;
  const search = (input: Record<string, unknown> = {}) => invoke<SearchPage>(tools.search_sessions, { query: '', offset: 0, limit: 5, include_archived: false, ...input });
  const read = (id: string, input: Record<string, unknown> = {}) => invoke<ReadPage>(tools.read_session, { session_id: id, limit: 20, include_archived: false, ...input });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-recall-'));
    repository = new SessionRepository({ rootDir: root, autoMigrate: false });
    tools = createSessionHistoryTools(repository, () => true);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('searches persisted dialogue after restart without a memory database and returns source references', async () => {
    const old = repository.create({ title: 'Trip to Kyoto' });
    const message = repository.appendMessage(old.id, { role: 'user', content: 'Our hotel reservation is AZUL-739.', timestamp: 1234 });
    repository.appendMessage(old.id, { role: 'assistant', content: 'We will arrive on Friday.' });
    const restarted = new SessionRepository({ rootDir: root, autoMigrate: false });
    tools = createSessionHistoryTools(restarted, () => true);
    const result = await search({ query: 'KYOTO azul-739' });
    expect(result).toMatchObject({ results: [{ id: old.id, title: 'Trip to Kyoto', excerpt: { id: message.id, sequence: 1, content: message.content } }], next_offset: null, partial: false });
    expect((await read(result.results[0].id)).messages.map((m) => m.content)).toEqual([message.content, 'We will arrive on Friday.']);
    expect(restarted.get(old.id).revision).toBe(repository.get(old.id).revision);
  });

  it('lists recent sessions and continues a bounded search beyond its first 100 records', async () => {
    for (let i = 0; i < 101; i++) {
      const session = repository.create({ title: `Conversation ${i}` });
      repository.appendMessage(session.id, { role: 'user', content: 'ordinary dialogue', timestamp: Date.now() + i * 1000 });
    }
    const getter = vi.spyOn(repository, 'readBounded');
    const first = await search({ query: 'absent' });
    expect(first).toMatchObject({ results: [], scanned_sessions: 100, next_offset: 100, partial: true });
    expect(getter).toHaveBeenCalledTimes(100);
    expect(await search({ query: 'absent', offset: first.next_offset })).toMatchObject({ results: [], scanned_sessions: 1, next_offset: null, partial: false });
    const recent = await search({ limit: 2 });
    expect(recent.results.map((r) => r.title)).toEqual(['Conversation 100', 'Conversation 99']);
    expect((await search({ limit: 2, offset: recent.next_offset })).results.map((r) => r.title)).toEqual(['Conversation 98', 'Conversation 97']);
  });

  it('reads conversations brought forward by the existing legacy migration', async () => {
    const web = join(root, 'legacy-web');
    mkdirSync(web);
    writeFileSync(join(web, 'thread.json'), JSON.stringify({ id: 'legacy-thread', title: 'Old planning', createdAt: 1, updatedAt: 2,
      messages: [{ id: 'old-user', role: 'user', content: 'Legacy launch detail amber-217', timestamp: 1 }] }));
    const options = { rootDir: join(root, 'canonical'), legacyWebChatDir: web, legacyShortTermDir: join(root, 'absent') };
    new SessionRepository(options);
    const restarted = new SessionRepository(options);
    tools = createSessionHistoryTools(restarted, () => true);
    const results = await search({ query: 'amber-217' });
    expect(results.results).toHaveLength(1);
    expect((await read(results.results[0].id)).messages[0].content).toBe('Legacy launch detail amber-217');
  });

  it('never returns deleted sessions and includes archived sessions only on request', async () => {
    const archived = repository.create({ title: 'Archived secret' });
    const deleted = repository.create({ title: 'Deleted secret' });
    repository.appendMessage(archived.id, { role: 'user', content: 'Archived dialogue' });
    repository.archive(archived.id);
    repository.markDeleted(deleted.id);
    expect((await search()).results).toEqual([]);
    expect((await search({ include_archived: true })).results.map((r) => r.id)).toEqual([archived.id]);
    expect(await read(archived.id)).toMatchObject({ error: expect.stringContaining('unavailable') });
    expect((await read(archived.id, { include_archived: true })).messages[0].content).toBe('Archived dialogue');
    const result = await read(deleted.id, { include_archived: true });
    expect(result).toMatchObject({ error: expect.stringContaining('unavailable') });
    expect(JSON.stringify(result)).not.toContain('Deleted secret');
    expect(await read(archived.alias)).toMatchObject({ error: expect.stringContaining('unavailable') });
  });

  it('excludes reasoning, metadata, internal records and tool traces from search and read', async () => {
    const session = repository.create({ title: 'Visible conversation' });
    const user = repository.appendMessage(session.id, { role: 'user', content: 'Visible question', metadata: { secret: 'hidden-metadata' }, externalMessageId: 'hidden-external-id' });
    repository.appendMessage(session.id, { role: 'assistant', content: 'Visible answer', reasoning: 'hidden-reasoning' });
    for (const kind of ['permission', 'progress', 'error', 'tool-call', 'tool-result', 'command'] as const) {
      repository.appendMessage(session.id, { role: 'assistant', kind, content: `hidden-${kind}` });
    }
    repository.appendMessage(session.id, { role: 'system', content: 'hidden-system' });
    repository.appendMessage(session.id, { role: 'tool', content: 'hidden-tool' });
    expect((await search({ query: 'hidden' })).results).toEqual([]);
    const page = await read(session.id);
    expect(page.messages.map((m) => m.content)).toEqual(['Visible question', 'Visible answer']);
    expect(page.messages[0]).toMatchObject({ id: user.id, sequence: 1, offset: 0 });
    expect(JSON.stringify(page)).not.toContain('hidden');
  });

  it('paginates long escaped and Unicode messages without losing content or exceeding the serialized bound', async () => {
    const session = repository.create({ title: '\u0000'.repeat(120) });
    const content = '😀\\\u0000\n'.repeat(5000);
    const original = repository.appendMessage(session.id, { role: 'assistant', content });
    repository.appendMessage(session.id, { role: 'user', content: 'The end' });
    const parts: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(session.id, { cursor });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(SESSION_RECALL_OUTPUT_LIMIT);
      for (const message of page.messages) {
        if (message.id === original.id) {
          expect(message.offset).toBe(parts.join('').length);
          expect(message.content).not.toMatch(/[\uD800-\uDBFF]$/);
          parts.push(message.content);
        }
      }
      cursor = page.next_cursor ?? undefined;
      expect(++pages).toBeLessThan(30);
    } while (cursor);
    expect(parts.join('')).toBe(content);
    expect(pages).toBeGreaterThan(1);
  });

  it('bounds search output after JSON escaping and supplies an excerpt around a late match', async () => {
    for (let i = 0; i < 10; i++) {
      const session = repository.create({ title: '\u0000'.repeat(120) });
      repository.appendMessage(session.id, { role: 'user', content: `${'prefix '.repeat(2000)}needle${'\u0000'.repeat(1000)}` });
    }
    const page = await search({ query: 'needle', limit: 10 });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(SESSION_RECALL_OUTPUT_LIMIT);
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.every((r) => r.excerpt?.content.includes('needle'))).toBe(true);
    expect(page.next_offset).not.toBeNull();
  });

  it('finishes a transcript ending in a stored lone surrogate instead of returning a stuck cursor', async () => {
    const session = repository.create();
    repository.appendMessage(session.id, { role: 'user', content: 'Hello \ud800' });
    expect(await read(session.id)).toMatchObject({ messages: [{ content: 'Hello \ud800', truncated: false }], next_cursor: null });
  });

  it.each([false, true])('keeps the next record for a fresh scan budget, counting failed reads too (damaged=%s)', async (damaged) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const session = repository.create({ title: `Budget ${i}` });
      repository.appendMessage(session.id, { role: 'user', content: i === 4 ? 'needle' : 'ordinary', timestamp: Date.now() + (10 - i) * 1000 });
      const content = damaged && i < 4 ? '{' : JSON.stringify(repository.get(session.id));
      writeFileSync(join(root, `${session.id}.json`), content.padEnd(7 * 1024 * 1024));
      ids.push(session.id);
    }
    const first = await search({ query: 'needle' });
    expect(first).toMatchObject({ results: [], next_offset: 4, scanned_sessions: 4, skipped_sessions: damaged ? 4 : 0, partial: true });
    const second = await search({ query: 'needle', offset: first.next_offset });
    expect(second).toMatchObject({ results: [{ id: ids[4] }], next_offset: null, skipped_sessions: 0, partial: false });
  });

  it('rejects stale or cross-session cursors and paginates message boundaries', async () => {
    const first = repository.create();
    const second = repository.create();
    for (const session of [first, second]) {
      repository.appendMessage(session.id, { role: 'user', content: 'One' });
      repository.appendMessage(session.id, { role: 'assistant', content: 'Two' });
    }
    const page = await read(first.id, { limit: 1 });
    expect((await read(first.id, { cursor: page.next_cursor })).messages.map((m) => m.content)).toEqual(['Two']);
    expect(await read(second.id, { cursor: page.next_cursor })).toMatchObject({ error: expect.stringContaining('Invalid cursor') });
    repository.appendMessage(first.id, { role: 'user', content: 'Changed' });
    expect(await read(first.id, { cursor: page.next_cursor })).toMatchObject({ error: expect.stringContaining('session changed') });
    expect(await read(first.id, { cursor: 'not-json' })).toMatchObject({ error: expect.stringContaining('Invalid cursor') });
  });

  it('reports oversized and damaged sessions as skipped instead of claiming a complete search', async () => {
    const huge = repository.create({ title: 'Too big' });
    const damaged = repository.create({ title: 'Damaged' });
    truncateSync(join(root, `${huge.id}.json`), 9 * 1024 * 1024);
    writeFileSync(join(root, `${damaged.id}.json`), '{');
    expect(await search()).toMatchObject({ results: [], skipped_sessions: 2, partial: true, next_offset: null });
    expect(await read(huge.id)).toMatchObject({ error: expect.stringContaining('8 MiB') });
    expect(await read(damaged.id)).toMatchObject({ error: expect.stringContaining('unavailable') });
  });

  it('denies remote unknown roles, members, disabled tools and restricted child contexts even through retained handles', async () => {
    const registry = new CapabilityRegistry();
    registry.setSessionRepository(repository);
    const saved = registry.getTools();
    const spy = vi.spyOn(repository, 'listSummaries');
    for (const channel of ['telegram', 'signal', 'slack', 'discord', 'whatsapp', 'plugin-channel']) {
      registry.setChannelContext('remote', channel);
      expect(registry.getTools()).not.toHaveProperty('search_sessions');
      expect(registry.getPlanTools()).not.toHaveProperty('read_session');
      expect(await invoke(saved.search_sessions, {})).toMatchObject({ error: expect.any(String) });
    }
    registry.setChannelContext('local', 'web');
    registry.permissions.setCurrentSenderRole('member');
    expect(await invoke(saved.read_session, {})).toMatchObject({ error: expect.any(String) });
    registry.permissions.setCurrentSenderRole(undefined);
    registry.setToolsDisabled(true);
    expect(await invoke(saved.search_sessions, {})).toMatchObject({ error: expect.any(String) });
    registry.setToolsDisabled(false);
    await registry.permissions.withContext(makeContext({ channelType: 'web', allowedTools: ['read_file'] }), async () => {
      expect(registry.getTools()).not.toHaveProperty('search_sessions');
      expect(registry.getPlanTools()).not.toHaveProperty('read_session');
      expect(await invoke(saved.read_session, {})).toMatchObject({ error: expect.any(String) });
    });
    expect(spy).not.toHaveBeenCalled();
    for (const channel of ['cli', 'web', 'desktop', 'internal']) {
      registry.setChannelContext('owner', channel);
      expect(registry.getTools()).toHaveProperty('search_sessions');
      expect(registry.getPlanTools()).toHaveProperty('read_session');
    }
    registry.setChannelContext('owner', 'telegram');
    registry.permissions.setCurrentSenderRole('admin');
    expect(registry.getPlanTools()).toHaveProperty('read_session');
  });
});
