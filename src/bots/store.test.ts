import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore, assertValidBotId, validateBotManifest, BOT_PERSONA_FILENAME, BOT_PERMISSIONS_FILENAME } from './store.js';
import { BotJournal } from './journal.js';
import type { BotManifest } from './types.js';

describe('bot id validation', () => {
  it('accepts lowercase ids with dashes', () => {
    expect(() => assertValidBotId('researcher')).not.toThrow();
    expect(() => assertValidBotId('a1')).not.toThrow();
    expect(() => assertValidBotId('social-media')).not.toThrow();
  });

  it('rejects traversal, case, and oversized ids', () => {
    expect(() => assertValidBotId('../etc')).toThrow();
    expect(() => assertValidBotId('..')).toThrow();
    expect(() => assertValidBotId('Researcher')).toThrow();
    expect(() => assertValidBotId('a'.repeat(49))).toThrow();
    expect(() => assertValidBotId('')).toThrow();
  });
});

describe('BotStore', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bots-'));
    store = new BotStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a profile dir with manifest, persona, and fail-closed permissions', () => {
    const m = store.create({ id: 'researcher', name: 'Research', description: 'Deep research' });
    expect(m.id).toBe('researcher');
    expect(m.enabled).toBe(true);
    expect(existsSync(join(root, 'researcher', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'researcher', BOT_PERSONA_FILENAME))).toBe(true);
    const perms = store.readPermissions('researcher');
    expect(perms.paths).toEqual([{ scope: 'self', read: true, write: true }]);
    const persona = store.readPersona('researcher');
    expect(persona).toContain('# Research');
  });

  it('rejects duplicate ids and invalid ids', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    expect(() => store.create({ id: 'alpha', name: 'Alpha 2' })).toThrow(/already exists/);
    expect(() => store.create({ id: '../escape', name: 'Bad' })).toThrow();
    expect(() => store.create({ id: '', name: 'Bad' })).toThrow();
  });

  it('lists created bots sorted by id', () => {
    store.create({ id: 'zeta', name: 'Zeta' });
    store.create({ id: 'alpha', name: 'Alpha' });
    const ids = store.list().map(m => m.id);
    expect(ids).toEqual(['alpha', 'zeta']);
  });

  it('round-trips manifest fields through YAML', () => {
    store.create({
      id: 'researcher',
      name: 'Research',
      manifest: {
        model: { provider: 'anthropic', model: 'claude-sonnet-5' },
        memory: { scope: 'shared-read', allowCrossBotRecall: ['publisher'] },
        comms: { canMessage: ['publisher'] },
        schedules: [{ name: 'morning-scan', cron: '0 9 * * *', prompt: 'Scan RSS' }],
        autonomy: { maxSteps: 30, dailyTokenBudget: 1000 },
      },
    });
    const loaded = store.get('researcher') as BotManifest;
    expect(loaded.model?.provider).toBe('anthropic');
    expect(loaded.model?.model).toBe('claude-sonnet-5');
    expect(loaded.memory?.scope).toBe('shared-read');
    expect(loaded.memory?.allowCrossBotRecall).toEqual(['publisher']);
    expect(loaded.comms?.canMessage).toEqual(['publisher']);
    expect(loaded.schedules?.[0].cron).toBe('0 9 * * *');
    expect(loaded.autonomy?.dailyTokenBudget).toBe(1000);
  });

  it('normalizes dangerous tools to deny-by-default when no allow list is set', () => {
    store.create({ id: 'writer', name: 'Writer' });
    const m = store.get('writer') as BotManifest;
    expect(m.tools?.deny).toContain('run_command');
    expect(m.tools?.deny).toContain('delete_file');
    // An explicit allow list opts in deliberately: with a non-empty allow,
    // only listed tools are available anyway, so deny stays exactly as written.
    store.create({ id: 'publisher', name: 'Publisher', manifest: { tools: { allow: ['read_file', 'shell'], deny: ['shell'] } } });
    const p = store.get('publisher') as BotManifest;
    expect(p.tools?.deny).toEqual(['shell']);
    expect(p.tools?.allow).toEqual(['read_file', 'shell']);
  });

  it('update mutates and persists', () => {
    store.create({ id: 'alpha', name: 'Alpha', manifest: { enabled: true } });
    const updated = store.update('alpha', m => { m.enabled = false; m.description = 'paused'; });
    expect(updated.enabled).toBe(false);
    expect((store.get('alpha') as BotManifest).enabled).toBe(false);
    expect((store.get('alpha') as BotManifest).updatedAt).not.toBe((store.get('alpha') as BotManifest).createdAt);
  });

  it('setEnabled flips enabled', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    store.setEnabled('alpha', false);
    expect((store.get('alpha') as BotManifest).enabled).toBe(false);
  });

  it('delete removes the profile dir entirely', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    expect(store.exists('alpha')).toBe(true);
    store.delete('alpha');
    expect(store.exists('alpha')).toBe(false);
    expect(existsSync(join(root, 'alpha'))).toBe(false);
  });

  it('skips malformed profile dirs on list instead of throwing', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'bot.yaml'), 'id: other\nname: Mismatch', 'utf-8');
    const ids = store.list().map(m => m.id);
    expect(ids).toEqual(['alpha']);
  });

  it('get rejects a manifest whose id does not match its directory', () => {
    const dir = join(root, 'researcher');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.yaml'), 'id: other\nname: Spoof', 'utf-8');
    expect(() => store.get('researcher')).toThrow(/mismatched id/);
  });

  it('rejects manifests with invalid schedules or self-referencing links', () => {
    const errors = validateBotManifest({
      id: 'x',
      name: 'X',
      schedules: [{ name: 'bad', cron: 'every morning', prompt: 'go' }],
      memory: { scope: 'shared-read', allowCrossBotRecall: ['x'] },
      comms: { canMessage: ['x'] },
    });
    expect(errors.some(e => e.includes('cron'))).toBe(true);
    expect(errors.some(e => e.includes('allowCrossBotRecall'))).toBe(true);
    expect(errors.some(e => e.includes('canMessage'))).toBe(true);
  });

  it('validates cross-bot references against other bot ids only structurally', () => {
    const errors = validateBotManifest({ id: 'x', name: 'X', comms: { canMessage: ['valid-id'] } });
    expect(errors).toEqual([]);
  });

  it('usage reports per-bot byte sizes', () => {
    store.create({ id: 'alpha', name: 'Alpha', persona: 'x'.repeat(2048) });
    const usage = store.usage();
    expect(usage).toHaveLength(1);
    expect(usage[0].id).toBe('alpha');
    expect(usage[0].bytes).toBeGreaterThan(0);
  });

  it('persona can be rewritten', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    store.writePersona('alpha', '# New persona');
    expect(store.readPersona('alpha')).toBe('# New persona');
  });

  it('permissions round-trip through YAML', () => {
    store.create({ id: 'alpha', name: 'Alpha' });
    store.writePermissions('alpha', {
      paths: [{ scope: './work', read: true, write: true }],
      blockedCommands: ['rm -rf'],
    });
    const perms = store.readPermissions('alpha');
    expect(perms.paths?.[0].scope).toBe('./work');
    expect(perms.blockedCommands).toEqual(['rm -rf']);
  });
});

describe('BotJournal', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-journal-'));
    dir = join(root, 'researcher');
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const record = (runId: string, state: 'completed' | 'failed' = 'completed') => ({
    runId,
    botId: 'alpha',
    trigger: 'cron' as const,
    state,
    startedAt: Date.now(),
    durationMs: 100,
    tokensIn: 10,
    tokensOut: 20,
  });

  it('appends and reads records newest-last', () => {
    const journal = new BotJournal(dir);
    journal.append(record('r1'));
    journal.append(record('r2'));
    const recent = journal.read('alpha');
    expect(recent.map(r => r.runId)).toEqual(['r1', 'r2']);
  });

  it('read with limit returns the most recent window', () => {
    const journal = new BotJournal(dir);
    for (let i = 0; i < 5; i++) journal.append(record(`r${i}`));
    expect(journal.read('alpha', 2).map(r => r.runId)).toEqual(['r3', 'r4']);
  });

  it('counts states across rotations', () => {
    const journal = new BotJournal(dir);
    journal.append(record('r1'));
    journal.append(record('r2', 'failed'));
    const counts = journal.counts('alpha');
    expect(counts.total).toBe(2);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.bytes).toBeGreaterThan(0);
  });

  it('rotates at the byte threshold and keeps only N rotations', () => {
    const journal = new BotJournal(dir, 200, 2);
    // Each record is ~200 bytes; enough appends to force multiple rotations.
    for (let i = 0; i < 10; i++) journal.append(record(`r${i}`));
    expect(existsSync(join(dir, 'journal.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'journal.jsonl.1'))).toBe(true);
    // keepRotations=2 means at most .1 and .2 exist — the bounded window.
    expect(existsSync(join(dir, 'journal.jsonl.3'))).toBe(false);
    const counts = journal.counts('alpha');
    // Bounded: the retained history is at most (1 + keepRotations) rotations
    // worth of records, not all 10 — oldest records are evicted by design.
    expect(counts.total).toBeGreaterThanOrEqual(2);
    expect(counts.total).toBeLessThanOrEqual(6);
    // Each rotation is at most the threshold plus one record overshoot.
    expect(counts.bytes).toBeLessThan((1 + 2) * 200 + 6 * 300);
  });

  it('returns empty for an unknown bot dir without throwing', () => {
    const journal = new BotJournal(dir);
    expect(journal.read('nonexistent')).toEqual([]);
    expect(journal.counts('nonexistent').total).toBe(0);
  });

  it('skips corrupt lines instead of failing reads', () => {
    const journal = new BotJournal(dir);
    journal.append(record('r1'));
    const file = join(dir, 'journal.jsonl');
    const existing = readFileSync(file, 'utf-8');
    writeFileSync(file, existing + '{corrupt\n' + existing, 'utf-8');
    const recent = journal.read('alpha', 10);
    expect(recent.every(r => r.runId)).toBe(true);
    expect(recent).toHaveLength(2);
  });
});