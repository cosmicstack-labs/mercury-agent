import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SessionRepository, SessionResolutionError } from './repository.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mercury-sessions-'));
  return { root, repository: new SessionRepository({ rootDir: join(root, 'sessions'), autoMigrate: false }) };
}

describe('SessionRepository', () => {
  it('creates, lists, gets, and reloads atomically persisted sessions', () => {
    const { root, repository } = fixture();
    const created = repository.create({ title: 'Test session', alias: 'amber-comet' });
    repository.appendMessage(created.id, { role: 'user', content: 'hello' });
    const reloaded = new SessionRepository({ rootDir: join(root, 'sessions'), autoMigrate: false });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get(created.id).messages[0]).toMatchObject({ content: 'hello', sequence: 1, sessionId: created.id });
    expect(readdirSync(join(root, 'sessions')).some((file) => file.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'sessions', 'index.json'), 'utf8')).sessions[0].alias).toBe('amber-comet');
  });

  it('quarantines a malformed index and rebuilds sessions and bindings', () => {
    const { root, repository } = fixture();
    const session = repository.create({ binding: { channelType: 'cli', externalConversationId: 'current' } });
    const sessionsDir = join(root, 'sessions');
    writeFileSync(join(sessionsDir, 'index.json'), '{not json');
    writeFileSync(join(sessionsDir, `${session.id}.json.123.tmp`), 'ignored');

    const recovered = new SessionRepository({ rootDir: sessionsDir, autoMigrate: false });

    expect(recovered.getByBinding('cli', 'current')?.id).toBe(session.id);
    expect(recovered.list()).toHaveLength(1);
    const files = readdirSync(sessionsDir);
    expect(files.some((file) => /^index\.json\.invalid-/.test(file))).toBe(true);
    expect(files).toContain(`${session.id}.json.123.tmp`);
  });

  it('rebuilds an index that references a missing session', () => {
    const { root, repository } = fixture();
    const present = repository.create({ alias: 'present-session' });
    const missing = repository.create({ alias: 'missing-session' });
    const sessionsDir = join(root, 'sessions');
    unlinkSync(join(sessionsDir, `${missing.id}.json`));

    const recovered = new SessionRepository({ rootDir: sessionsDir, autoMigrate: false });

    expect(recovered.dump().map((session) => session.id)).toEqual([present.id]);
    expect(() => recovered.get(missing.id)).toThrow(/not found/);
    expect(readdirSync(sessionsDir).some((file) => /^index\.json\.invalid-/.test(file))).toBe(true);
  });

  it('quarantines a corrupt individual session while retaining valid sessions', () => {
    const { root, repository } = fixture();
    const valid = repository.create({ alias: 'valid-session' });
    const corrupt = repository.create({ alias: 'corrupt-session' });
    const sessionsDir = join(root, 'sessions');
    writeFileSync(join(sessionsDir, `${corrupt.id}.json`), JSON.stringify({ id: corrupt.id, messages: null }));

    const recovered = new SessionRepository({ rootDir: sessionsDir, autoMigrate: false });

    expect(recovered.dump().map((session) => session.id)).toEqual([valid.id]);
    const quarantined = readdirSync(sessionsDir).find((file) => file.startsWith(`${corrupt.id}.json.invalid-`));
    expect(quarantined).toBeDefined();
    expect(JSON.parse(readFileSync(join(sessionsDir, quarantined!), 'utf8'))).toEqual({ id: corrupt.id, messages: null });
  });

  it('resolves UUID prefixes and aliases without guessing ambiguity', () => {
    const { repository } = fixture();
    const first = repository.create({ id: 'aaaaaaaa-1111-4111-8111-111111111111', alias: 'silver-star' });
    repository.create({ id: 'aaaabbbb-2222-4222-8222-222222222222', alias: 'silver-signal' });
    expect(repository.resolve(first.shortId).id).toBe(first.id);
    expect(repository.resolve('silver-star').id).toBe(first.id);
    expect(repository.resolve('SILVER-ST').id).toBe(first.id);
    expect(() => repository.resolve('aaaa')).toThrow(SessionResolutionError);
    expect(() => repository.resolve('silver-s')).toThrow(/silver-star.*silver-signal/);
  });

  it('maintains one mutable binding and adopts canonical UUIDs', () => {
    const { repository } = fixture();
    const first = repository.getOrCreateBound('cli', 'current');
    const adopted = repository.getOrCreateBound('web', 'browser-thread', 'bbbbbbbb-1111-4111-8111-111111111111');
    expect(repository.getByBinding('cli', 'current')?.id).toBe(first.id);
    repository.bind(adopted.id, 'cli', 'current');
    expect(repository.getByBinding('cli', 'current')?.id).toBe(adopted.id);
    expect(repository.get(first.id).bindings).toHaveLength(0);
    expect(repository.getByBinding('web', 'browser-thread')?.id).toBe(adopted.id);
  });

  it('deduplicates messages by external ID and archives sessions', () => {
    const { repository } = fixture();
    const session = repository.create();
    const first = repository.appendMessage(session.id, { role: 'user', content: 'once', externalMessageId: 'transport-1' });
    const duplicate = repository.appendMessage(session.id, { role: 'user', content: 'changed', externalMessageId: 'transport-1' });
    expect(duplicate.id).toBe(first.id);
    expect(repository.get(session.id).messages).toHaveLength(1);
    repository.archive(session.id);
    expect(repository.list()).toHaveLength(0);
    expect(repository.list({ includeArchived: true })[0].status).toBe('archived');
  });

  it('keeps a message-free deletion tombstone until it is purged after sync', () => {
    const { root, repository } = fixture();
    const session = repository.create({ binding: { channelType: 'cli', externalConversationId: 'current' } });
    repository.appendMessage(session.id, { role: 'user', content: 'private transcript' });
    const deleted = repository.markDeleted(session.id);
    expect(deleted).toMatchObject({ status: 'deleted', messages: [], bindings: [] });
    expect(repository.list()).toHaveLength(0);
    expect(repository.dump()).toHaveLength(1);
    expect(repository.getByBinding('cli', 'current')).toBeNull();
    repository.purgeDeleted([session.id]);
    expect(repository.dump()).toHaveLength(0);
    expect(() => repository.get(session.id)).toThrow(/not found/);
    expect(readdirSync(join(root, 'sessions'))).not.toContain(`${session.id}.json`);
  });

  it('permanently deletes the session file, index entry, and every binding', () => {
    const { root, repository } = fixture();
    const session = repository.create({ binding: { channelType: 'cli', externalConversationId: 'current' } });
    repository.bind(session.id, 'web', 'thread-1');
    repository.appendMessage(session.id, { role: 'user', content: 'erase me' });

    const deleted = repository.deletePermanently(session.alias);

    expect(deleted.id).toBe(session.id);
    expect(repository.list({ includeArchived: true, includeDeleted: true })).toEqual([]);
    expect(repository.getByBinding('cli', 'current')).toBeNull();
    expect(repository.getByBinding('web', 'thread-1')).toBeNull();
    expect(readdirSync(join(root, 'sessions'))).not.toContain(`${session.id}.json`);
    const index = JSON.parse(readFileSync(join(root, 'sessions', 'index.json'), 'utf8'));
    expect(index.sessions).toEqual([]);
    expect(index.bindings).toEqual({});
    expect(() => repository.deletePermanently(session.id)).toThrow(/not found/);
  });

  it('updates titles, revisions, and mutation subscribers idempotently', () => {
    const { repository } = fixture();
    const session = repository.create();
    let mutations = 0;
    const unsubscribe = repository.subscribe(() => mutations++);
    const updated = repository.updateTitle(session.id, '  Canonical   Session Title  ', 'generated');
    expect(updated).toMatchObject({ title: 'Canonical Session Title', titleSource: 'generated' });
    expect(updated.revision).toBeGreaterThan(session.revision);
    repository.updateTitle(session.id, 'Canonical Session Title', 'generated');
    expect(mutations).toBe(1);
    unsubscribe();
    repository.archive(session.id);
    expect(mutations).toBe(1);
    expect(() => repository.updateTitle(session.id, ' '.repeat(2))).toThrow(/required/);
  });

  it('imports legacy web and short-term JSON idempotently without deleting sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-migration-'));
    const web = join(root, 'web-chat-history');
    const short = join(root, 'short-term');
    mkdirSync(web);
    mkdirSync(short);
    writeFileSync(join(web, 'thread.json'), JSON.stringify({
      id: 'thread-1', title: 'Legacy thread', createdAt: 1, updatedAt: 3, messages: [
        { id: 'u1', role: 'user', content: 'same', timestamp: 1 },
        { id: 'u2', role: 'user', content: 'same', timestamp: 2 },
        { id: 'a1', role: 'assistant', content: 'answer', timestamp: 3 },
      ],
    }));
    writeFileSync(join(short, 'cli.json'), JSON.stringify([{ id: 'c1', role: 'user', content: 'cli legacy', timestamp: 4 }]));
    const options = { rootDir: join(root, 'sessions'), legacyWebChatDir: web, legacyShortTermDir: short };
    const repository = new SessionRepository(options);
    expect(repository.getByBinding('web', 'thread-1')).toMatchObject({ createdAt: 1, updatedAt: 3 });
    expect(repository.getByBinding('web', 'thread-1')?.messages).toHaveLength(2);
    expect(repository.getByBinding('cli', 'cli')?.messages[0].content).toBe('cli legacy');
    expect(new SessionRepository(options).dump()).toHaveLength(2);
    expect(readdirSync(web)).toContain('thread.json');
    expect(readdirSync(short)).toContain('cli.json');
  });
});
