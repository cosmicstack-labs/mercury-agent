import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore, BotStore as Store } from './store.js';
import { BotManager } from './bot-manager.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

// Mock only generateText — no LLM work in these tests (delete/migration paths).
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

function makeManager(root: string): BotManager {
  const config = getDefaultConfig() as MercuryConfig;
  config.bots.maxConcurrent = 4;
  const manager = new BotManager({
    config,
    providers: {
      get: () => undefined,
      getDefault: () => ({
        name: 'stub', model: 'stub-model',
        generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: 'stub' }),
        streamText: async function* () { yield { text: 'ok', done: true }; },
        isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model',
      } as any),
    } as any,
    tokenBudget: { recordUsage: () => {}, getRemaining: () => 100000, getStatusText: () => '', getUsagePercentage: () => 0 } as any,
    store: new Store(join(root, 'bots')),
    userMemoryFactory: () => null,
  });
  activeManagers.push(manager);
  return manager;
}

// Windows EBUSY guard: every BotManager owns an open SQLite queue handle;
// afterEach disposes all of them before the tmpdir is deleted.
const activeManagers: Array<{ dispose: () => void }> = [];

describe('fleet physical layout (crew nests under the lead)', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-layout-'));
    store = new BotStore(join(root, 'bots'));
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a crew bot INSIDE the lead\'s directory', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    expect(existsSync(join(root, 'bots', 'ceo', 'backend', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'bots', 'backend', 'bot.yaml'))).toBe(false);
    expect(store.botDir('backend')).toBe(join(root, 'bots', 'ceo', 'backend'));
  });

  it('rejects creating crew whose lead does not exist', () => {
    expect(() => store.create({ id: 'orphan', name: 'Orphan', manifest: { fleetRole: 'crew', parent: 'ghost' } }))
      .toThrow(/does not exist/);
  });

  it('list() discovers nested crew and rejects parent cycles on save', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    const ids = store.list().map(m => m.id);
    expect(ids).toEqual(['backend', 'ceo']);

    // Hand-edited cycle (backend's parent = ceo, ceo's parent = backend).
    store.update('ceo', m => { m.fleetRole = 'lead'; });
    const ceoFile = store.botDir('ceo');
    expect(() => {
      // Simulate a hand-edit that would create the cycle backend → ceo → backend.
      store.save({ ...store.get('ceo')!, parent: 'backend' });
    }).toThrow(/cycle/i);
    // save() with an updated manifest must not have corrupted the file.
    expect(store.get('ceo')!.parent).toBeUndefined();
    void ceoFile;
  });

  it('re-parents move the profile dir; promote moves it back to the root', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'cto', name: 'CTO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'qa', name: 'QA', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    store.update('qa', m => { m.parent = 'cto'; });
    expect(existsSync(join(root, 'bots', 'cto', 'qa', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'bots', 'ceo', 'qa', 'bot.yaml'))).toBe(false);
    store.update('qa', m => { m.parent = undefined; m.fleetRole = undefined; });
    expect(existsSync(join(root, 'bots', 'qa', 'bot.yaml'))).toBe(true);
  });

  it('deleting the lead removes the whole crew tree from disk', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    store.delete('ceo');
    expect(existsSync(join(root, 'bots', 'ceo'))).toBe(false);
    expect(existsSync(join(root, 'bots', 'ceo', 'backend', 'bot.yaml'))).toBe(false);
    expect(store.get('backend')).toBeNull();
  });

  it('reconciliation: a manually created folder under a lead is adopted as crew', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    // Simulate the user hand-creating a fleet member: folder + bot.yaml, no parent.
    const dir = join(root, 'bots', 'ceo', 'scribe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.yaml'), 'id: scribe\nname: Scribe\nenabled: true\n', 'utf-8');

    const listed = store.list().map(m => m.id);
    expect(listed).toContain('scribe');
    const m = store.get('scribe')!;
    expect(m.parent).toBe('ceo');
    expect(m.fleetRole).toBe('crew');
    expect(m.comms?.canMessage).toContain('ceo');
    // Idempotent: a second list() must not re-adopt or move anything.
    expect(store.list().map(x => x.id)).toEqual(['ceo', 'scribe'].sort());
    expect(existsSync(join(root, 'bots', 'ceo', 'scribe', 'bot.yaml'))).toBe(true);
  });

  it('reconciliation: a manifest naming a parent moves the folder under the lead', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    // Hand-created at the root with the parent set in the manifest.
    const dir = join(root, 'bots', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.yaml'), 'id: worker\nname: Worker\nenabled: true\nfleetRole: crew\nparent: ceo\n', 'utf-8');

    store.list();
    expect(existsSync(join(root, 'bots', 'ceo', 'worker', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'bots', 'worker', 'bot.yaml'))).toBe(false);
  });

  it('reconciliation: when folder and manifest disagree, the manifest wins', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'cto', name: 'CTO', manifest: { fleetRole: 'lead' } });
    // Placed under cto by hand, but the manifest says ceo.
    const dir = join(root, 'bots', 'cto', 'qa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.yaml'), 'id: qa\nname: QA\nenabled: true\nfleetRole: crew\nparent: ceo\n', 'utf-8');

    store.list();
    expect(existsSync(join(root, 'bots', 'ceo', 'qa', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'bots', 'cto', 'qa', 'bot.yaml'))).toBe(false);
    expect(store.get('qa')!.parent).toBe('ceo');
  });

  it('the full CEO tree renders as nested folders', () => {
    store.create({ id: 'ceo-bot', name: 'CEO Bot', manifest: { fleetRole: 'lead' } });
    for (const [id, parent] of [['product-bot', 'ceo-bot'], ['engineering-lead', 'ceo-bot'], ['qa-bot', 'ceo-bot'], ['security-bot', 'ceo-bot'], ['documentation-bot', 'ceo-bot']] as const) {
      store.create({ id, name: id, manifest: { fleetRole: 'crew', parent } });
    }
    store.create({ id: 'backend-bot', name: 'Backend Bot', manifest: { fleetRole: 'crew', parent: 'engineering-lead' } });
    store.create({ id: 'frontend-bot', name: 'Frontend Bot', manifest: { fleetRole: 'crew', parent: 'engineering-lead' } });

    expect(store.botDir('backend-bot')).toBe(join(root, 'bots', 'ceo-bot', 'engineering-lead', 'backend-bot'));
    expect(store.crewOf('ceo-bot').map(m => m.id).sort()).toEqual(
      ['documentation-bot', 'engineering-lead', 'product-bot', 'qa-bot', 'security-bot']);
    expect(store.crewOf('engineering-lead').map(m => m.id).sort()).toEqual(['backend-bot', 'frontend-bot']);
    expect(store.list().map(m => m.id)).toHaveLength(8);
  });

  it('migrateFleetLayout: deletes orphans, relocates flat crew under existing leads', async () => {
    const manager = makeManager(root);
    const store2 = manager['store'];
    // Surviving lead + flat crew + an orphaned crew (lead already deleted).
    // The orphan is seeded as raw files: the new create() guard refuses
    // dangling parents, but legacy disks have them.
    store2.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store2.create({ id: 'worker', name: 'Worker', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    mkdirSync(join(root, 'bots', 'stranded'), { recursive: true });
    writeFileSync(join(root, 'bots', 'stranded', 'bot.yaml'),
      `id: stranded\nname: Stranded\nenabled: true\nfleetRole: crew\nparent: dead-lead\n`, 'utf-8');

    await manager.migrateFleetLayout();

    expect(store2.get('stranded')).toBeNull();
    expect(existsSync(join(root, 'bots', 'stranded'))).toBe(false);
    expect(existsSync(join(root, 'bots', 'worker', 'bot.yaml'))).toBe(false);
    expect(existsSync(join(root, 'bots', 'ceo', 'worker', 'bot.yaml'))).toBe(true);
    expect(store2.get('worker')!.parent).toBe('ceo');
    // Idempotent second run changes nothing.
    await manager.migrateFleetLayout();
    expect(existsSync(join(root, 'bots', 'ceo', 'worker', 'bot.yaml'))).toBe(true);
  });
});

describe('fleet depth cap (creation allows exactly what the roster can see)', () => {
  let root: string;
  let manager: BotManager;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-depth-'));
    manager = makeManager(root);
    store = manager['store'];
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('addCrew builds the third level and refuses the fourth', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    expect(manager.addCrew('ceo', { id: 'eng-lead', name: 'Eng Lead' }).ok).toBe(true);
    manager.promoteLead('eng-lead');

    const third = manager.addCrew('eng-lead', { id: 'backend', name: 'Backend' });
    expect(third.ok).toBe(true);
    // Level 3 is the deepest level list() and crewOf() reach — a bot created
    // there is a bot the roster can show. Anything deeper used to be created
    // and then disappear from both.
    expect(store.list().map(m => m.id)).toContain('backend');
    expect(store.crewOf('eng-lead').map(m => m.id)).toContain('backend');

    manager.promoteLead('backend');
    const fourth = manager.addCrew('backend', { id: 'intern', name: 'Intern' });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error).toMatch(/3 levels/);
    expect(store.get('intern')).toBeNull();
    expect(existsSync(join(root, 'bots', 'ceo', 'eng-lead', 'backend', 'intern'))).toBe(false);
    expect(store.list().map(m => m.id).sort()).toEqual(['backend', 'ceo', 'eng-lead']);
  });

  it('a hand-written fourth level is refused on create and on save', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'eng-lead', name: 'Eng Lead', manifest: { fleetRole: 'lead', parent: 'ceo' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'lead', parent: 'eng-lead' } });

    expect(() =>
      store.create({ id: 'intern', name: 'Intern', manifest: { fleetRole: 'crew', parent: 'backend' } }))
      .toThrow(/3 levels/);

    // Re-parenting into the same depth is refused before the profile dir moves,
    // so a refused write leaves the disk where it was.
    store.create({ id: 'qaid', name: 'QA' });
    expect(() => store.update('qaid', m => { m.fleetRole = 'crew'; m.parent = 'backend'; }))
      .toThrow(/3 levels/);
    expect(existsSync(join(root, 'bots', 'qaid', 'bot.yaml'))).toBe(true);
    expect(existsSync(join(root, 'bots', 'ceo', 'eng-lead', 'backend', 'qaid'))).toBe(false);
    expect(store.get('qaid')!.parent).toBeUndefined();
  });
});

describe('fleet cascade delete (manager lifecycle)', () => {
  let root: string;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-cascade-'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('deleting a lead cascade-deletes every crew member (queues + routines + profile)', async () => {
    const store = manager['store'];
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'worker', name: 'Worker', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    manager.enqueue('worker', { trigger: 'chat', prompt: 'pending work' });

    await manager.delete('ceo');

    expect(store.get('worker')).toBeNull();
    expect(manager.getStatusSummaries().find(s => s.id === 'worker')).toBeUndefined();
    expect(manager.getQueuedCount('worker')).toBe(0);
    expect(existsSync(join(root, 'bots', 'ceo', 'worker'))).toBe(false);
  });

  it('cascade is recursive through a mid-level lead', async () => {
    const store = manager['store'];
    // CEO → Eng Lead → Backend (3 levels).
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.create({ id: 'eng', name: 'Eng Lead', manifest: { fleetRole: 'lead', parent: 'ceo' } });
    store.create({ id: 'backend', name: 'Backend', manifest: { fleetRole: 'crew', parent: 'eng' } });

    await manager.delete('ceo');

    expect(store.get('eng')).toBeNull();
    expect(store.get('backend')).toBeNull();
    expect(existsSync(join(root, 'bots', 'ceo'))).toBe(false);
  });
});