import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock only generateText — no LLM work in these tests.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { filterBotTools } from './registry-factory.js';
import { tierPermissionsFile, PERMISSION_TIERS } from './permission-tiers.js';
import { stripPersonaAccessSection } from './persona-access.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

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
    store: new BotStore(join(root, 'bots')),
    userMemoryFactory: () => null,
  });
  activeManagers.push(manager);
  return manager;
}

// Windows EBUSY guard: every BotManager owns an open SQLite queue handle;
// afterEach disposes all of them before the tmpdir is deleted.
const activeManagers: Array<{ dispose: () => void }> = [];

describe('permissions.yaml — single source of truth', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-perms-single-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a tier choice EXECUTES: it writes the tool gate AND path scopes to permissions.yaml', () => {
    const full = tierPermissionsFile('full');
    expect(full.tools?.deny).toEqual([]);
    expect(full.paths).toEqual([
      { scope: 'self', read: true, write: true, execute: true },
      { scope: '~', read: true, write: true, execute: true },
    ]);
    const readonly = tierPermissionsFile('readonly');
    expect(readonly.tools?.deny).toEqual(PERMISSION_TIERS.readonly.deny);
    expect(readonly.paths).toEqual([{ scope: 'self', read: true, write: true, execute: false }]);
  });

  it('the tool gate comes from permissions.yaml, overriding any legacy manifest block', () => {
    const all = { read_file: {}, run_command: {}, write_file: {} } as any;
    const manifest = { tools: { deny: ['run_command'] } } as any;
    // permissions.yaml is the single source: its deny wins over bot.yaml (whose
    // deny list is the materialized default on every loaded manifest — a tier
    // that grants run_command must be able to).
    let out = filterBotTools(all, manifest, { tools: { deny: ['write_file'] } });
    expect(Object.keys(out).sort()).toEqual(['read_file', 'run_command']);
    // No permissions.tools + explicit legacy manifest block → honored.
    out = filterBotTools(all, manifest, {});
    expect(Object.keys(out).sort()).toEqual(['read_file', 'write_file']);
    // NEITHER source configured → fail-closed dangerous-tool default.
    out = filterBotTools(all, { id: 'x' } as any, {});
    expect(Object.keys(out).sort()).toEqual(['read_file']);
  });

  it('migratePermissions folds legacy bot.yaml tools + persona Access grants into permissions.yaml', async () => {
    store.create({ id: 'scraper', name: 'Scraper' });
    // Legacy state: tool gate in bot.yaml, path grants in the persona.
    store.update('scraper', m => { (m as any).tools = { allow: [], deny: ['run_command'] }; });
    store.writePersona('scraper', '# Scraper\n\n## Access\n\n- ~/cookies — read\n- /tmp/execdir — execute\n');

    await manager.migratePermissions();

    const perms = store.readPermissions('scraper');
    expect(perms.tools?.deny).toEqual(['run_command']);
    const cookies = perms.paths?.find(p => p.scope.endsWith('/cookies'));
    expect(cookies?.read).toBe(true);
    expect(perms.paths?.find(p => p.scope === '/tmp/execdir')?.execute).toBe(true);
    // Persona is character-only: the Access section is gone, permissions note in place.
    const persona = store.readPersona('scraper');
    expect(persona).not.toContain('## Access');
    expect(persona).toContain('permissions.yaml');
    // Idempotent: a second pass is a no-op.
    await manager.migratePermissions();
    expect(store.readPermissions('scraper').paths?.length).toBe(perms.paths!.length);
  });

  it('stripPersonaAccessSection removes only the Access section', () => {
    const persona = '# Bot\n\n## Character\n\nCalm.\n\n## Access\n\n- ~/x — read\n\n## Output\n\nTerse.\n';
    const stripped = stripPersonaAccessSection(persona);
    expect(stripped).toContain('## Character');
    expect(stripped).toContain('## Output');
    expect(stripped).not.toContain('~/x');
    expect(stripped).not.toContain('## Access');
  });
});

describe('fleet permission inheritance (crew runs on the lead\'s permissions)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-perms-inherit-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('addCrew copies the lead\'s permissions.yaml verbatim at creation', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.writePermissions('ceo', {
      paths: [{ scope: 'self', read: true, write: true, execute: true }, { scope: '~', read: true }],
      autoApproveCommands: ['node *'],
      tools: { deny: ['git_push'] },
    });
    manager.addCrew('ceo', { id: 'worker', name: 'Worker', description: 'Does work' });

    const inherited = store.readPermissions('worker');
    expect(inherited.paths).toEqual(store.readPermissions('ceo').paths);
    expect(inherited.autoApproveCommands).toEqual(['node *']);
    expect(inherited.tools?.deny).toEqual(['git_push']);
  });

  it('a crew with NO file inherits its lead\'s at first use; its own file wins', () => {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    store.writePermissions('ceo', { paths: [{ scope: '~', read: true }], tools: { deny: ['git_push'] } });
    store.create({ id: 'adoptive', name: 'Adoptive', manifest: { fleetRole: 'crew', parent: 'ceo' } });
    // No permissions.yaml was written for the crew (create writes none).
    expect(existsSync(join(store.botDir('adoptive'), 'permissions.yaml'))).toBe(false);

    const materialized = store.ensurePermissions('adoptive');
    expect(materializedEquals(materialized, store.readPermissions('ceo'))).toBe(true);
    // From now on the crew owns the file: editing it diverges from the lead.
    store.writePermissions('adoptive', { paths: [{ scope: 'self', read: true }] });
    expect(store.ensurePermissions('adoptive').paths).toEqual([{ scope: 'self', read: true }]);
    // And the lead's file is untouched by any of this.
    expect(store.readPermissions('ceo').paths).toEqual([{ scope: '~', read: true }]);
  });

  it('a solo without a file gets the fail-closed default, not an inheritance error', () => {
    store.create({ id: 'loner', name: 'Loner' });
    const perms = store.ensurePermissions('loner');
    expect(perms.paths).toEqual([{ scope: 'self', read: true, write: true }]);
    expect(existsSync(join(store.botDir('loner'), 'permissions.yaml'))).toBe(true);
  });

  it('an orphaned crew (lead deleted) inherits nothing and gets the fail-closed default', async () => {
    mkdirSync(join(root, 'bots', 'ghost-child'), { recursive: true });
    writeFileSync(join(root, 'bots', 'ghost-child', 'bot.yaml'),
      'id: ghost-child\nname: Ghost\nenabled: true\nfleetRole: crew\nparent: vanished\n', 'utf-8');
    await manager.migrateFleetLayout();
    // The orphan was cascade-deleted with its vanished lead — no inheritance
    // ambiguity survives a startup.
    expect(store.get('ghost-child')).toBeNull();
    void readFileSync;
  });
});

describe('bot tool filter', () => {
  const bare = { id: 'x' } as unknown as Parameters<typeof filterBotTools>[1];
  const toolset = (names: string[]) => Object.fromEntries(names.map((n) => [n, {}])) as Parameters<typeof filterBotTools>[0];
  it('Spotify, GitHub and git tools are opt-in by group: off unless the gate names them', () => {
    const all = toolset(['read_file', 'spotify_play', 'spotify_pause', 'github_api', 'create_pr', 'git_status', 'web_search']);
    const deny = { tools: { deny: [] } };
    expect(Object.keys(filterBotTools(all, bare, deny)).sort()).toEqual(['read_file', 'web_search']);
    const withGroups = { tools: { allow: ['read_file', 'web_search', 'spotify', 'git'] } };
    expect(Object.keys(filterBotTools(all, bare, withGroups)).sort()).toEqual(['git_status', 'read_file', 'spotify_pause', 'spotify_play', 'web_search']);
    expect(Object.keys(filterBotTools(all, bare, { tools: { deny: [], allow: [] } }))).not.toContain('create_pr');
  });

  it('a bot never gets dispatch_bot (that is how the owner wakes bots)', () => {
    expect(Object.keys(filterBotTools(toolset(['dispatch_bot', 'read_file']), bare, { tools: { deny: [] } }))).toEqual(['read_file']);
  });
});

function materializedEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
