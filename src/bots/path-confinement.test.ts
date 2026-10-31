import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { BotStore } from './store.js';
import { createBotCapabilityRegistry } from './registry-factory.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import type { BotManifest, BotPermissionsFile } from './types.js';

/**
 * Regression: a bot with a wide grant ("~") whose cwd was a code checkout
 * wrote its "_shared/…" files into that repo (mercury-agent, 10 Oct 2026).
 */
let root: string;
let store: BotStore;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mercury-bot-paths-'));
  store = new BotStore(join(root, 'bots'));
  repo = join(root, 'some-repo');
  mkdirSync(repo, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function buildRegistry(id: string) {
  const manifest = store.create({ id, name: id }) as BotManifest;
  const permissions: BotPermissionsFile = {
    ...store.ensurePermissions(id),
    // Wide grant, like the real article-writer: read/write everywhere under root.
    paths: [{ scope: root, read: true, write: true, execute: true }],
  };
  return createBotCapabilityRegistry({
    botId: id,
    manifest,
    botDir: store.botDir(id),
    permissions,
    userMemory: null,
    config: getDefaultConfig() as MercuryConfig,
    sandbox: { workspace: store.sandboxDir(id), shared: store.sharedSandboxDir() },
  });
}

async function run(tools: Record<string, Tool>, name: string, args: Record<string, unknown>): Promise<string> {
  const t = tools[name] as Tool & { execute: (a: unknown, o: unknown) => Promise<string> };
  return t.execute(args, { toolCallId: 't', messages: [] });
}

describe('bot relative paths stay in the bot\'s own folders', () => {
  it('"_shared/…" lands in the fleet-shared folder, even after cd into a repo', async () => {
    const registry = buildRegistry('writer');
    const tools = registry.getTools();
    // cd into the repo is refused (outside the bot's own folders)…
    expect(await run(tools, 'cd', { path: repo })).toMatch(/only change directory inside your own work folders/);
    expect(registry.getCwd()).toBe(store.sandboxDir('writer'));
    // …and even if the cwd were the repo, "_shared/" means the fleet folder.
    (registry as unknown as { currentCwd: string }).currentCwd = repo;
    await run(tools, 'create_file', { path: '_shared/report.md', content: 'hello' });
    expect(existsSync(join(repo, '_shared'))).toBe(false);
    expect(readFileSync(join(store.sharedSandboxDir(), 'report.md'), 'utf8')).toBe('hello');
  });

  it('"sandbox/…" and plain relative paths land in the private workspace', async () => {
    const registry = buildRegistry('scout');
    const tools = registry.getTools();
    await run(tools, 'create_file', { path: 'sandbox/a.md', content: 'a' });
    await run(tools, 'create_file', { path: 'b.md', content: 'b' });
    expect(readFileSync(join(store.sandboxDir('scout'), 'a.md'), 'utf8')).toBe('a');
    expect(readFileSync(join(store.sandboxDir('scout'), 'b.md'), 'utf8')).toBe('b');
  });

  it('cd within its own folders still works, and absolute paths under a grant still work', async () => {
    const registry = buildRegistry('editor');
    const tools = registry.getTools();
    expect(await run(tools, 'cd', { path: store.sharedSandboxDir() })).toMatch(/^Changed directory/);
    writeFileSync(join(repo, 'notes.md'), 'x');
    expect(await run(tools, 'read_file', { path: join(repo, 'notes.md') })).toContain('x');
  });
});
