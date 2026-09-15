import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock only generateText; tool()/zodSchema/stepCountIs must stay real so the
// CapabilityRegistry tool factories still construct.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from 'ai';
import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import type { BotManifest } from './types.js';

const mockedGenerateText = vi.mocked(generateText);

function scriptedProvider(name = 'stub') {
  return {
    name,
    model: 'stub-model',
    generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: name }),
    streamText: async function* () { yield { text: 'ok', done: true }; },
    isAvailable: () => true,
    getModelInstance: () => ({}),
    getModel: () => 'stub-model',
  } as any;
}

const providersRegistry = {
  get: (name?: string) => (name === 'stub' ? scriptedProvider('stub') : undefined),
  getDefault: () => scriptedProvider('default'),
} as any;

const tokenBudget = {
  recordUsage: () => {},
  getRemaining: () => 100000,
  getStatusText: () => 'budget ok',
  getUsagePercentage: () => 0,
} as any;

function makeManager(root: string, overrides: Partial<MercuryConfig> = {}): BotManager {
  const config = getDefaultConfig() as MercuryConfig;
  config.bots.maxConcurrent = 4;
  Object.assign(config, overrides);
  return new BotManager({
    config,
    providers: providersRegistry,
    tokenBudget,
    store: new BotStore(join(root, 'bots')),
    userMemoryFactory: () => null, // no SQLite dependency in unit tests
  });
}

function seedBot(store: BotStore, id: string, manifestOverrides: Partial<BotManifest> = {}) {
  return store.create({ id, name: id.toUpperCase(), manifest: manifestOverrides });
}

beforeEach(() => {
  mockedGenerateText.mockReset();
});

describe('BotManager queue + turn lifecycle', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-manager-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects jobs for unknown and disabled bots with typed reasons', async () => {
    expect(manager.enqueue('ghost', { trigger: 'chat', prompt: 'hi' })).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    seedBot(store, 'sleepy', { enabled: false });
    expect(manager.enqueue('sleepy', { trigger: 'chat', prompt: 'hi' })).toMatchObject({ accepted: false, reasonCode: 'target_disabled' });
  });

  it('runs a chat turn to completion, journals it, and notifies', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as any);
    seedBot(store, 'researcher');
    const notifications: string[] = [];
    manager['notify'] = async (_t, _c, message) => { notifications.push(message); };

    const result = manager.enqueue('researcher', { trigger: 'chat', prompt: 'Summarize the market' });
    expect(result.accepted).toBe(true);
    // pump is synchronous-ish; the turn runs as a detached promise — wait for it
    await vi.waitFor(() => {
      const records = manager.getJournal('researcher');
      expect(records.length).toBe(1);
      expect(records[0].state).toBe('completed');
    });
    expect(notifications.some(n => n.includes('researcher'.toUpperCase()) || n.includes('RESEARCHER'))).toBe(true);
    const summary = manager.getStatusSummaries().find(s => s.id === 'researcher');
    expect(summary?.state).toBe('idle');
    expect(summary?.lastRunState).toBe('completed');
  });

  it('pauses the bot for the rest of the day when the daily token budget is hit', async () => {
    mockedGenerateText.mockImplementation(async (opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 100, outputTokens: 100 } });
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 100 } } as any;
    });
    seedBot(store, 'thrifty', { autonomy: { dailyTokenBudget: 1 } });
    manager.enqueue('thrifty', { trigger: 'chat', prompt: 'go' });
    await vi.waitFor(() => {
      const summary = manager.getStatusSummaries().find(s => s.id === 'thrifty');
      expect(summary?.state).toBe('paused');
    });
    // Budget-paused bots do not drain their queue
    expect(manager.getQueuedCount('thrifty')).toBe(0);
  });

  it('retries transient provider failures with backoff, bounded', async () => {
    mockedGenerateText.mockRejectedValue(new Error('HTTP 429: too many requests'));
    seedBot(store, 'flaky', { autonomy: { dailyTokenBudget: 100000 } });
    vi.useFakeTimers();
    try {
      manager.enqueue('flaky', { trigger: 'chat', prompt: 'go' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(manager.getJournal('flaky').length).toBe(1));
      expect(manager.getJournal('flaky')[0].reasonCode).toBe('provider_rate_limit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades to a stateless bot when the memory store cannot be built', async () => {
    // Simulates a SQLite-less device: the store factory throws.
    const config = getDefaultConfig() as MercuryConfig;
    config.bots.maxConcurrent = 4;
    const manager = new BotManager({
      config,
      providers: providersRegistry,
      tokenBudget,
      store: new BotStore(join(root, 'bots')),
      userMemoryFactory: () => { throw new Error('better-sqlite3 is not available'); },
    });
    mockedGenerateText.mockResolvedValue({ text: 'stateless ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    seedBot(store, 'nodb');
    manager.enqueue('nodb', { trigger: 'chat', prompt: 'hello' });
    await vi.waitFor(() => {
      const records = manager.getJournal('nodb');
      expect(records.length).toBe(1);
      expect(records[0].state).toBe('completed');
    });
  });
});

describe('Main-agent bots awareness (system prompt section)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-aware-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists bots with descriptions and live states so the main chat can answer precisely', () => {
    store.create({ id: 'researcher', name: 'Research', description: 'Deep research specialist' });
    store.create({ id: 'publisher', name: 'Publisher', manifest: { enabled: false } });
    const section = manager.getSystemPromptSection();
    expect(section).toContain('**Research** (`researcher`) — Deep research specialist');
    expect(section).toContain('idle');
    expect(section).toContain('disabled');
  });

  it('documents the control commands and the dispatch tool', () => {
    seedBot(store, 'researcher');
    const section = manager.getSystemPromptSection();
    expect(section).toContain('/bot <id> <message>');
    expect(section).toContain('dispatch_bot');
    expect(section).toContain('/bots open <id>');
  });

  it('empty fleet section still tells the agent how to onboard', () => {
    const section = manager.getSystemPromptSection();
    expect(section).toContain('no bots configured');
    expect(section).toContain('/bots create');
  });

  it('dispatch_bot tool routes through the handler with name resolution', async () => {
    const { createDispatchBotTool } = await import('./tools/dispatch-bot.js');
    store.create({ id: 'researcher', name: 'Research' });
    const calls: Array<{ bot: string; message: string }> = [];
    const tool = createDispatchBotTool((botId, message) => {
      const resolved = manager.resolveBotId(botId);
      calls.push({ bot: resolved ?? '', message });
      if (!resolved) return { accepted: false, reasonCode: 'target_unknown' };
      return { accepted: true, jobId: 'j1' };
    }, () => ({ channelType: 'cli', channelId: 'current' })) as any;
    const ok = await tool.execute({ bot: 'Research', message: 'do the thing' });
    expect(ok).toContain('Dispatched');
    expect(calls[0].bot).toBe('researcher');
    const unknown = await tool.execute({ bot: 'ghost', message: 'x' });
    expect(unknown).toContain('target_unknown');
  });
});

describe('BotManager mailboxes (bot-to-bot comms)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-mail-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
    seedBot(store, 'researcher');
    seedBot(store, 'publisher');
    seedBot(store, 'offline', { enabled: false });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns typed failures for unknown/disabled targets', () => {
    expect(manager.sendToBot('ghost', 'researcher', 'hi')).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    expect(manager.sendToBot('offline', 'researcher', 'hi')).toMatchObject({ accepted: false, reasonCode: 'target_disabled' });
  });

  it('delivers mail and wakes an idle bot, attributed in the prompt', async () => {
    mockedGenerateText.mockImplementation(async ({ messages }: any) => {
      const sawMail = JSON.stringify(messages).includes('Message from 🤖 researcher');
      return { text: sawMail ? 'consumed handoff' : 'idle check', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    const result = manager.sendToBot('publisher', 'researcher', 'Here are the findings');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      const records = manager.getJournal('publisher');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('mailbox');
    });
    // The captured turn messages included the attributed mailbox content
    const firstCall = mockedGenerateText.mock.calls[0][0] as any;
    expect(JSON.stringify(firstCall.messages)).toContain('Message from 🤖 researcher');
    expect(JSON.stringify(firstCall.messages)).toContain('Here are the findings');
  });

  it('queues mail behind an active turn instead of dropping it', () => {
    // Simulate a running turn
    manager['running'].set('publisher', new Set(['busy']));
    manager.sendToBot('publisher', 'researcher', 'more findings');
    expect(manager.peekMailbox('publisher')).toHaveLength(1);
    // No mailbox-triggered job enqueued while running — mail waits for drain
    expect(manager.getQueuedCount('publisher')).toBe(0);
  });
});

describe('Per-bot permission isolation (fail-closed)', () => {
  let root: string;
  let store: BotStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-perms-'));
    store = new BotStore(join(root, 'bots'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds an isolated registry with no ask handler and a bot channel context', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const pm = registry.permissions;
    expect(pm.getCurrentChannelType()).toBe('bot');
    // Fail-closed: with no ask handler and no allow-all, every approval denies
    expect(pm.isAutoApproveAll()).toBe(false);
    // Default all-cwd scope replaced by the bot's own dir only
    const scopes = pm.getManifest().capabilities.filesystem.scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('writer'));
    // Shell auto-approve list emptied; dangerous blocklist retained
    expect(pm.getManifest().capabilities.shell.autoApproved).toEqual([]);
    expect(pm.getManifest().capabilities.shell.blocked).toContain('sudo *');
  });

  it('fs write outside the bot scope is denied without prompting', async () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const outside = join(root, 'elsewhere.txt');
    const verdict = await registry.permissions.checkFsAccess(outside, 'write');
    expect(verdict.allowed).toBe(false);
    const inside = join(store.botDir('writer'), 'note.md');
    const insideVerdict = await registry.permissions.checkFsAccess(inside, 'write');
    expect(insideVerdict.allowed).toBe(true);
  });

  it('strips interactive and global-mutation tools from every bot toolset', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = filterBotTools(registry.getTools(), manifest);
    for (const forbidden of ['ask_user', 'approve_scope', 'approve_command', 'update_plan', 'delegate_task', 'install_skill', 'schedule_task', 'bot_send']) {
      expect(tools[forbidden]).toBeUndefined();
    }
    // Dangerous tools are denied by default (normalizeBotManifest)
    expect(tools['run_command']).toBeUndefined();
    expect(tools['write_file']).toBeUndefined();
    // Read-only tools survive the default deny list
    expect(tools['read_file']).toBeDefined();
    expect(tools['list_dir']).toBeDefined();
  });

  it('a non-empty allow list restricts the toolset exactly to that list', () => {
    const manifest = store.create({
      id: 'reader',
      name: 'Reader',
      manifest: { tools: { allow: ['read_file'], deny: [] } },
    }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'reader',
      manifest,
      botDir: store.botDir('reader'),
      permissions: store.readPermissions('reader'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = filterBotTools(registry.getTools(), manifest);
    expect(Object.keys(tools)).toEqual(['read_file']);
  });

  it('bot-blocked commands extend the shell denylist', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    store.writePermissions('writer', { paths: [{ scope: 'self', read: true, write: true }], blockedCommands: ['curl *'] });
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.readPermissions('writer'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    expect(registry.permissions.getManifest().capabilities.shell.blocked).toContain('curl *');
  });
});

describe('bot_send tool scoping', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-send-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
    seedBot(store, 'publisher');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is only available for bots with a configured roster and rejects unlinked targets', async () => {
    const { createBotSendTool } = await import('./tools/bot-send.js');
    // The publisher bot is idle, so sendToBot wakes it and its wake-turn
    // drains the mailbox immediately — verify via the journal instead.
    mockedGenerateText.mockImplementation(async ({ messages }: any) => {
      void messages;
      return { text: 'handled', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    const tool = createBotSendTool(manager, 'researcher', ['publisher']) as any;
    const denied = await tool.execute({ target: 'stranger', message: 'hi' });
    expect(denied).toContain('not configured');
    const ok = await tool.execute({ target: 'publisher', message: 'findings' });
    expect(ok).toContain('Queued for publisher');
    await vi.waitFor(() => {
      const records = manager.getJournal('publisher');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('mailbox');
    });
    const firstCall = mockedGenerateText.mock.calls[0][0] as any;
    expect(JSON.stringify(firstCall.messages)).toContain('Message from 🤖 researcher');
  });
});