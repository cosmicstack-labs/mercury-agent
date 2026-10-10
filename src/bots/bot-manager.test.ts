import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock only generateText; tool()/zodSchema/stepCountIs must stay real so the
// CapabilityRegistry tool factories still construct.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

import { generateText, streamText } from 'ai';
import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { SkillLoader } from '../skills/loader.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import type { BotManifest } from './types.js';

const mockedGenerateText = vi.mocked(generateText);

const mockedStreamText = vi.mocked(streamText);
// Bot turns run on streamText (live thinking deltas). Tests script
// generateText; this shim feeds THAT script through the streaming shape the
// turn loop consumes: the (async, mocked) generateText call fires the same
// step callbacks inside fullStream consumption, and its final result shows
// up as the text/finishReason promises runBotTurn awaits.
mockedStreamText.mockImplementation(((opts: any) => {
  let final = { text: '', finishReason: 'stop', usage: {} };
  let failed: unknown = null;
  let resolveSettled: () => void = () => { };
  const settled = new Promise<void>((r) => { resolveSettled = r; });
  const gen: any = (generateText as any)(opts) || Promise.resolve(final);
  const fullStream = (async function* () {
    try {
      final = await gen;
    } catch (err) {
      failed = err; // rethrown by the text/finishReason promises below
    }
    resolveSettled();
  })();
  // Resolve only after the underlying generateText settles; its promises
  // must never reject unhandled (the fullStream consumer owns the error).
  const once = async (pick: () => any) => { await settled; if (failed !== null) throw failed; return pick(); };
  return {
    fullStream,
    text: once(() => final.text),
    finishReason: once(() => final.finishReason),
    // runBotTurn reads usage from onStepFinish — usage must never reject
    // unhandled (Promise.all only consumes text/finishReason).
    usage: once(() => final.usage).catch(() => ({})),
  };
}) as any);

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
  const manager = new BotManager({
    config,
    providers: providersRegistry,
    tokenBudget,
    store: new BotStore(join(root, 'bots')),
    userMemoryFactory: () => null, // no SQLite dependency in unit tests
  });
  activeManagers.push(manager);
  return manager;
}

function seedBot(store: BotStore, id: string, manifestOverrides: Partial<BotManifest> = {}) {
  return store.create({ id, name: id.toUpperCase(), manifest: manifestOverrides });
}

beforeEach(() => {
  mockedStreamText.mockClear();
    mockedGenerateText.mockReset();
});

// Windows EBUSY guard: every BotManager owns an open SQLite queue handle;
// afterEach disposes all of them before the tmpdir is deleted.
const activeManagers: Array<{ dispose: () => void }> = [];

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
    for (const m of activeManagers.splice(0)) m.dispose();
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
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (_t, target, message) => { delivered.push({ target, message }); };

    const result = manager.enqueue('researcher', { trigger: 'chat', prompt: 'Summarize the market', source: { channelType: 'cli', channelId: 'current' } });
    expect(result.accepted).toBe(true);
    // pump is synchronous-ish; the turn runs as a detached promise — wait for it
    await vi.waitFor(() => {
      const records = manager.getJournal('researcher');
      expect(records.length).toBe(1);
      expect(records[0].state).toBe('completed');
    });
    // Hermes/OpenClaw contract: the full result lands in the bot's OWN thread;
    // the CLI session that asked gets NOTHING — no pointer into the main chat
    // (a delayed routine/retry run would otherwise print into whatever
    // session is open days later — the thread leak).
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'bot:researcher' && d.message.includes('done'))).toBe(true);
    });
    expect(delivered.every(d => d.target === 'bot:researcher')).toBe(true);
    expect(delivered.some(d => d.message.includes('finished its task'))).toBe(false);
    const summary = manager.getStatusSummaries().find(s => s.id === 'researcher');
    expect(summary?.state).toBe('idle');
    expect(summary?.lastRunState).toBe('completed');
  });

  it('bot-thread delivery is NOT sliced at the old 800-char cap', async () => {
    const long = 'x'.repeat(700) + 'MIDDLE-MARKER' + 'y'.repeat(700);
    mockedGenerateText.mockResolvedValue({ text: long, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    seedBot(store, 'reporter');
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (_t, target, message) => { delivered.push({ target, message }); };
    manager.enqueue('reporter', { trigger: 'chat', prompt: 'long report please' });
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'bot:reporter' && d.message.includes('MIDDLE-MARKER'))).toBe(true);
    });
  });

  it('remote source channels still receive the full result (no bot threads there)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'remote done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as any);
    seedBot(store, 'courier');
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (t, target, message) => { delivered.push({ target: `${t}:${target}`, message }); };
    manager.enqueue('courier', { trigger: 'chat', prompt: 'go', source: { channelType: 'telegram', channelId: 'chat-42' } });
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'telegram:chat-42' && d.message.includes('remote done'))).toBe(true);
    });
    // The bot thread still gets it too.
    expect(delivered.some(d => d.target === 'cli:bot:courier' && d.message.includes('remote done'))).toBe(true);
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

  it('a retried job never runs twice when the due-sweep and the backoff timer both fire (P0.7)', async () => {
    let calls = 0;
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>(r => { releaseSecond = r; });
    mockedGenerateText.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('HTTP 429: too many requests');
      await secondGate; // hold the retry turn so the timer fires while it RUNS
      return { text: 'recovered', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    seedBot(store, 'racer');
    // setImmediate stays real: the mocked turn is promise-driven, so a few
    // real macrotask yields settle it deterministically without waitFor.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
    try {
      const { jobId } = manager.enqueue('racer', { trigger: 'chat', prompt: 'go' });
      await settle();
      // Attempt 1 failed transiently → durable in-place retry, 1s backoff timer.
      expect(manager.getJournal('racer').map(r => r.state)).toEqual(['failed']);
      expect(manager.queue.pendingJobs('racer').map(j => j.id)).toEqual([jobId]);

      // The periodic sweep wins the race: the clock passes run_after WITHOUT
      // the backoff timer firing, and the sweep moves the job into `running`.
      vi.setSystemTime(Date.now() + 1000);
      (manager as any).resumeDueJobs();
      await settle();
      expect(calls).toBe(2);
      expect((manager as any).running.get('racer')?.has(jobId)).toBe(true);

      // Now the backoff timer fires while that retry is still running. The
      // old timer pushed its own copy (the queue was empty) → a second run.
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.getQueuedCount('racer')).toBe(0);
      expect(calls).toBe(2);

      releaseSecond();
      await settle();
      // A later sweep tick finds nothing due either: the job settled 'done'.
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(calls).toBe(2);
      expect(manager.getJournal('racer').map(r => r.state)).toEqual(['failed', 'completed']);
      expect(manager.queue.counts()).toMatchObject({ pending: 0, claimed: 0, dlq: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs-you survives a manager restart (journal row) and clears on the next run (P0.7)', async () => {
    mockedGenerateText.mockRejectedValue(new Error('permission denied: no permission for that path'));
    seedBot(store, 'stuck');
    manager.enqueue('stuck', { trigger: 'chat', prompt: 'go' });
    await vi.waitFor(() => {
      expect(manager.getStatusSummaries().find(s => s.id === 'stuck')?.needsYou).toBe(true);
    });
    expect(manager.getJournal('stuck')[0]).toMatchObject({ state: 'failed', reasonCode: 'permission_denied', needsYou: true });

    // Restart: a new manager on the same root must still show the escalation.
    manager.dispose();
    const restarted = makeManager(root);
    expect(restarted.getStatusSummaries().find(s => s.id === 'stuck')?.needsYou).toBe(true);

    // The next run clears it — in memory AND durably.
    mockedGenerateText.mockResolvedValue({ text: 'fine now', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    restarted.enqueue('stuck', { trigger: 'chat', prompt: 'again' });
    await vi.waitFor(() => expect(restarted.getJournal('stuck')).toHaveLength(2));
    expect(restarted.getStatusSummaries().find(s => s.id === 'stuck')?.needsYou).toBe(false);
    restarted.dispose();
    const again = makeManager(root);
    expect(again.getStatusSummaries().find(s => s.id === 'stuck')?.needsYou).toBe(false);
  });

  it('stop holds queued jobs (durable, nothing lost) and start resumes them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockedGenerateText.mockImplementation(() => gate.then(() => ({ text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any)));
    seedBot(store, 'worker');
    manager.enqueue('worker', { trigger: 'chat', prompt: 'one' });
    manager.enqueue('worker', { trigger: 'chat', prompt: 'two' }); // queues behind the running turn
    await vi.waitFor(() => expect(manager.getQueuedCount('worker')).toBe(1));

    const stop = await manager.stop('worker');
    expect(stop.halted).toBe(true);
    expect(stop.heldJobs).toBe(1);
    expect(manager.getQueuedCount('worker')).toBe(0);
    // The queued job is NOT destroyed — its durable row stays pending.
    expect(manager.queue.pendingJobs('worker').map(j => j.prompt)).toContain('two');

    release(); // let the in-flight turn finish
    await vi.waitFor(() => expect(manager.getJournal('worker').length).toBe(1));

    const start = manager.start('worker');
    expect(start.resumed).toBe(1);
    await vi.waitFor(() => expect(manager.getJournal('worker').length).toBe(2));
  });

  it('start on an idle stopped bot resumes nothing and reports it', async () => {
    seedBot(store, 'calm');
    await manager.stop('calm'); // nothing running, nothing queued
    expect(manager.start('calm').resumed).toBe(0);
    expect(manager.getStatusSummaries().find(s => s.id === 'calm')?.state).toBe('idle');
  });

  it('runNow fires a configured routine now, rejects unknown ones, and wakes bare', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'digest done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } } as any);
    seedBot(store, 'crony', { schedules: [{ name: 'digest', cron: '0 9 * * *', prompt: 'Write the daily digest' }] });
    // Name resolution is case-insensitive; the run is journalled with trigger cron.
    expect(manager.runNow('crony', 'DIGEST').accepted).toBe(true);
    await vi.waitFor(() => {
      const records = manager.getJournal('crony');
      expect(records.length).toBe(1);
      expect(records[0].trigger).toBe('cron');
      expect(records[0].summary).toContain('digest done');
    });
    expect(manager.runNow('crony', 'nope')).toMatchObject({ accepted: false, reasonCode: 'routine_unknown' });
    expect(manager.runNow('ghost', 'digest')).toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    // No routine named → a bare wake turn with the canned wake prompt.
    expect(manager.runNow('crony').accepted).toBe(true);
  });

  it('tells the bot its sandbox paths and the shared-folder standing rule', async () => {
    seedBot(store, 'pathfinder');
    let systemPrompt = '';
    mockedGenerateText.mockImplementation(async (opts: any) => {
      systemPrompt = opts.system ?? '';
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    manager.enqueue('pathfinder', { trigger: 'chat', prompt: 'hi' });
    await vi.waitFor(() => {
      expect(systemPrompt).toContain(store.sandboxDir('pathfinder'));
      expect(systemPrompt).toContain('_shared');
      expect(systemPrompt).toContain('DATA other bots consume');
    });
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
    activeManagers.push(manager);
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
    for (const m of activeManagers.splice(0)) m.dispose();
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
    // The main agent must not promise main-chat delivery — results live in
    // the bot thread only (§3.1, thread-leak fix).
    expect(section).toContain('never in this chat');
  });

  it('empty fleet produces NO prompt section (zero drift for botless users)', () => {
    const section = manager.getSystemPromptSection();
    expect(section).toBe('');
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
    for (const m of activeManagers.splice(0)) m.dispose();
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
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('builds an isolated registry with no ask handler and a bot channel context', () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.ensurePermissions('writer'),
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

  it('the persona is NOT a permission source — grants must come from permissions.yaml', () => {
    const manifest = store.create({ id: 'cookiebot', name: 'Cookiebot' }) as BotManifest;
    // A persona with an Access section grants NOTHING at registry build time.
    store.writePersona('cookiebot', `# Cookiebot\n\n## Access\n\n- ~/cookies — read\n- /tmp/execdir — execute\n`);
    const registry = createBotCapabilityRegistry({
      botId: 'cookiebot',
      manifest,
      botDir: store.botDir('cookiebot'),
      permissions: store.ensurePermissions('cookiebot'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    // Only the materialized default (own dir) + sandbox — NO persona grants.
    expect(scopes.some(s => s.path === store.botDir('cookiebot'))).toBe(true);
    expect(scopes.some(s => s.path.endsWith('/cookies'))).toBe(false);
    expect(scopes.some(s => s.path === '/tmp/execdir')).toBe(false);
    // The startup migration is what folds persona grants into the file.
    expect(store.ensurePermissions('cookiebot').paths?.some(p => p.scope === '~' || p.scope.endsWith('/cookies'))).toBe(false);
  });

  it('a malformed permissions.yaml entry (missing "scope") is skipped, not fatal', () => {
    // Hand-edit typo class: `socpe:` instead of `scope:` — the registry build
    // must never crash every turn over it (the entry is just skipped).
    const manifest = store.create({ id: 'typo', name: 'Typo' }) as BotManifest;
    store.writePermissions('typo', {
      paths: [
        { scope: 'self', read: true, write: true },
        { socpe: '/tmp/cookies', read: true } as unknown as { scope: string; read: boolean },
      ],
    });
    const registry = createBotCapabilityRegistry({
      botId: 'typo',
      manifest,
      botDir: store.botDir('typo'),
      permissions: store.readPermissions('typo'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    // The malformed entry contributed nothing; the valid self scope survived.
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('typo'));
  });

  it('a persona without an Access section changes nothing (current permissions apply)', () => {
    const manifest = store.create({ id: 'plainbot', name: 'Plainbot' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'plainbot',
      manifest,
      botDir: store.botDir('plainbot'),
      permissions: store.ensurePermissions('plainbot'),
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0].path).toBe(store.botDir('plainbot'));
  });

  it('grants the private sandbox and fleet-shared folder implicitly (rw+x)', () => {
    const manifest = store.create({ id: 'sandboxer', name: 'Sandboxer' }) as BotManifest;
    // create() materializes both sandbox areas
    expect(existsSync(store.sandboxDir('sandboxer'))).toBe(true);
    expect(existsSync(store.sharedSandboxDir())).toBe(true);
    // and the shared dir is never mistaken for a bot
    expect(store.list().map(m => m.id)).toEqual(['sandboxer']);
    const registry = createBotCapabilityRegistry({
      botId: 'sandboxer',
      manifest,
      botDir: store.botDir('sandboxer'),
      permissions: store.ensurePermissions('sandboxer'),
      sandbox: { workspace: store.sandboxDir('sandboxer'), shared: store.sharedSandboxDir() },
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const scopes = registry.permissions.getManifest().capabilities.filesystem.scopes;
    const workspace = scopes.find(s => s.path === store.sandboxDir('sandboxer'));
    const shared = scopes.find(s => s.path === store.sharedSandboxDir());
    expect(workspace).toMatchObject({ read: true, write: true, execute: true });
    expect(shared).toMatchObject({ read: true, write: true, execute: true });
  });

  it('bot toolset gains list_skills + use_skill; install_skill stays stripped', () => {
    const manifest = store.create({ id: 'skillful', name: 'Skillful' }) as BotManifest;
    const loader = new SkillLoader(join(root, 'skills'), { seedDefaults: false });
    loader.discover();
    const registry = createBotCapabilityRegistry({
      botId: 'skillful',
      manifest,
      botDir: store.botDir('skillful'),
      permissions: store.readPermissions('skillful'),
      skillLoader: loader,
      userMemory: null,
      config: getDefaultConfig() as MercuryConfig,
    });
    const tools = registry.getTools();
    expect(tools.list_skills).toBeDefined();
    expect(tools.use_skill).toBeDefined();
    const filtered = filterBotTools({ ...tools }, manifest);
    expect(filtered.list_skills).toBeDefined();
    expect(filtered.use_skill).toBeDefined();
    expect(filtered.install_skill).toBeUndefined();
  });

  it('fs write outside the bot scope is denied without prompting', async () => {
    const manifest = store.create({ id: 'writer', name: 'Writer' }) as BotManifest;
    const registry = createBotCapabilityRegistry({
      botId: 'writer',
      manifest,
      botDir: store.botDir('writer'),
      permissions: store.ensurePermissions('writer'),
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

  describe('bot shell allow-list (autoApproveCommands)', () => {
    it('runs an allow-listed command in fail-closed mode without prompting', async () => {
      const manifest = store.create({ id: 'sheller', name: 'Sheller' }) as BotManifest;
      store.writePermissions('sheller', {
        paths: [{ scope: 'self', read: true, write: true }],
        autoApproveCommands: ['node *', 'python3 *'],
      });
      const registry = createBotCapabilityRegistry({
        botId: 'sheller',
        manifest,
        botDir: store.botDir('sheller'),
        permissions: store.readPermissions('sheller'),
        userMemory: null,
        config: getDefaultConfig() as MercuryConfig,
      });
      const pm = registry.permissions;
      await expect(pm.checkShellCommand('node script.js --flag')).resolves.toMatchObject({ allowed: true, needsApproval: false });
      await expect(pm.checkShellCommand('python3 -m foo')).resolves.toMatchObject({ allowed: true, needsApproval: false });
      // Not on the allow-list: still denied (fail-closed, no ask handler).
      await expect(pm.checkShellCommand('curl evil.example')).resolves.toMatchObject({ allowed: false });
    });

    it('needsApproval patterns win over the same autoApprove pattern (deny)', async () => {
      const manifest = store.create({ id: 'guarded', name: 'Guarded' }) as BotManifest;
      store.writePermissions('guarded', {
        paths: [{ scope: 'self', read: true, write: true }],
        autoApproveCommands: ['npm *'],
        blockedCommands: ['npm publish *'],
      });
      const registry = createBotCapabilityRegistry({
        botId: 'guarded',
        manifest,
        botDir: store.botDir('guarded'),
        permissions: store.readPermissions('guarded'),
        userMemory: null,
        config: getDefaultConfig() as MercuryConfig,
      });
      const pm = registry.permissions;
      await expect(pm.checkShellCommand('npm run build')).resolves.toMatchObject({ allowed: true, needsApproval: false });
      // blockedCommands always wins — merged into the global blocked list.
      await expect(pm.checkShellCommand('npm publish @scope/pkg')).resolves.toMatchObject({ allowed: false });
    });

    it('segments the command: an approved base cannot launder a chained destructive command', async () => {
      const manifest = store.create({ id: 'chained', name: 'Chained' }) as BotManifest;
      store.writePermissions('chained', {
        paths: [{ scope: 'self', read: true, write: true }],
        autoApproveCommands: ['echo *'],
      });
      const registry = createBotCapabilityRegistry({
        botId: 'chained',
        manifest,
        botDir: store.botDir('chained'),
        permissions: store.readPermissions('chained'),
        userMemory: null,
        config: getDefaultConfig() as MercuryConfig,
      });
      const pm = registry.permissions;
      await expect(pm.checkShellCommand('echo hello')).resolves.toMatchObject({ allowed: true, needsApproval: false });
      await expect(pm.checkShellCommand('echo hi; reboot now')).resolves.toMatchObject({ allowed: false });
      await expect(pm.checkShellCommand('echo $(rm -rf ~)')).resolves.toMatchObject({ allowed: false });
    });

    it('rejects a literal "*" autoApprove pattern (no allow-all for bots)', () => {
      const manifest = store.create({ id: 'greedy', name: 'Greedy' }) as BotManifest;
      store.writePermissions('greedy', {
        paths: [{ scope: 'self', read: true, write: true }],
        autoApproveCommands: ['*'],
      });
      const registry = createBotCapabilityRegistry({
        botId: 'greedy',
        manifest,
        botDir: store.botDir('greedy'),
        permissions: store.readPermissions('greedy'),
        userMemory: null,
        config: getDefaultConfig() as MercuryConfig,
      });
      expect(registry.permissions.getManifest().capabilities.shell.autoApproved).toEqual([]);
    });
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
    for (const m of activeManagers.splice(0)) m.dispose();
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
describe('Bot skill access (native + own library)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-skills-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, body: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\nallowed-tools: []\n---\n\n${body}\n`);
  }

  it('turn prompts list native skills AND the bot\'s own library', async () => {
    // Default skills root = <botsRoot>/../skills — the native library.
    writeSkill(join(root, 'skills'), 'shared-procedure', 'Native procedure steps.');
    // The bot's OWN library: synthesized or hand-authored, bot-private.
    writeSkill(store.skillsDir('skilled'), 'own-procedure', 'The bot learned this itself.');
    seedBot(store, 'skilled');
    let systemPrompt = '';
    mockedGenerateText.mockImplementation(async (opts: any) => {
      systemPrompt = opts.system ?? '';
      return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    manager.enqueue('skilled', { trigger: 'chat', prompt: 'hi' });
    await vi.waitFor(() => {
      expect(systemPrompt).toContain('own-procedure');
      expect(systemPrompt).toContain('shared-procedure');
    });
  });
});

describe('Bot fleets (lead + crew)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-fleet-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function setupFleet() {
    store.create({ id: 'ceo', name: 'CEO', manifest: { fleetRole: 'lead' } });
    manager.addCrew('ceo', { id: 'researcher', name: 'Researcher', description: 'Research', persona: '# Researcher\n\nStudies markets.' });
    manager.addCrew('ceo', { id: 'writer', name: 'Writer', persona: '# Writer\n\nWrites copy.' });
  }

  function runtimeFor(id: string) {
    return (manager as unknown as { getOrCreateRuntime(id: string, m: BotManifest): { tools: Record<string, any> } }).getOrCreateRuntime(id, store.get(id)!);
  }

  it('addCrew enforces the lead relationship, the crew cap, and fail-closed defaults', () => {
    setupFleet();
    expect(store.get('researcher')?.fleetRole).toBe('crew');
    expect(store.get('researcher')?.parent).toBe('ceo');
    expect(store.get('researcher')?.comms?.canMessage).toEqual(['ceo']);
    for (let i = 0; i < 4; i++) manager.addCrew('ceo', { id: `extra${i}`, name: `Extra${i}` });
    expect(manager.addCrew('ceo', { id: 'over-cap', name: 'Over' })).toMatchObject({ ok: false });
    store.create({ id: 'solo-bot', name: 'Solo' });
    expect(manager.addCrew('solo-bot', { id: 'x', name: 'X' })).toMatchObject({ ok: false }); // not a lead
    // Replay-safety: re-adding a member the lead already has (by id or
    // normalized name) is a no-op success, not a duplicate bot on disk.
    expect(manager.addCrew('ceo', { id: 'researcher', name: 'Dup' })).toMatchObject({ ok: true, duplicate: true });
    expect(manager.addCrew('ceo', { id: 'brand-new-id', name: 'researcher' })).toMatchObject({ ok: true, duplicate: true });
    expect(store.list().filter(m => m.parent === 'ceo')).toHaveLength(6);
  });

  it('delegated tasks return results to the lead mailbox (attributed)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'MARKET REPORT: all clear', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } } as any);
    setupFleet();
    // Spy on delivery: the lead's wake turn would drain the mailbox before we
    // can peek — the sendToBot call itself is the observable contract.
    const sendSpy = vi.spyOn(manager, 'sendToBot');
    const dispatch = manager.dispatchTask('researcher', 'ceo', 'Study the market');
    expect(dispatch.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith('ceo', 'researcher', expect.stringContaining('MARKET REPORT'));
    });
    sendSpy.mockRestore();
  });

  it('plain mailbox mail never triggers a result reply (no ping-pong)', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'noted', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    setupFleet();
    manager.sendToBot('researcher', 'ceo', 'fyi only, no action');
    await vi.waitFor(() => expect(manager.getJournal('researcher').length).toBe(1));
    await new Promise(r => setTimeout(r, 50)); // let any detached follow-up turns settle
    expect(manager.peekMailbox('ceo')).toHaveLength(0);
  });

  it('a lead\'s mailbox wake delivers its synthesis to the bot thread; crew task results stay internal (P0.7)', async () => {
    setupFleet();
    const delivered: Array<{ target: string; message: string }> = [];
    manager['notify'] = async (_t, target, message) => { delivered.push({ target, message }); };
    mockedGenerateText.mockImplementation(async (opts: any) => {
      const text = JSON.stringify(opts?.messages ?? '');
      // Lead wake (mailbox trigger) after the crew result landed: synthesize.
      if (text.includes('Task complete')) {
        return { text: 'SYNTHESIS: combined market report', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
      }
      // Crew task turn (mailbox trigger with a reply target = the lead).
      if (text.includes('Study the market')) {
        return { text: 'CREW RESULT: market is up', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
      }
      // Lead's first (chat) turn: delegate.
      manager.dispatchTask('researcher', 'ceo', 'Study the market');
      return { text: 'dispatched', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });

    manager.enqueue('ceo', { trigger: 'chat', prompt: 'delegate the market work' });
    // The lead's combined report reaches the lead's own thread, tagged as
    // the mailbox turn it came from (it used to be journaled only).
    await vi.waitFor(() => {
      expect(delivered.some(d => d.target === 'bot:ceo' && d.message.includes('(mailbox): SYNTHESIS'))).toBe(true);
    });
    // The crew's task result went to the lead's MAILBOX only — the internal
    // crew→lead mail is never shown to the user, on any surface.
    expect(delivered.some(d => d.message.includes('CREW RESULT'))).toBe(false);
    expect(delivered.some(d => d.message.includes('Task complete (job'))).toBe(false);
    expect(delivered.some(d => d.target === 'bot:researcher')).toBe(false);
  });

  it('leads get fleet tools; bot_spawn/bot_retire manage the crew within the cap', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'A meticulous QA reviewer persona.', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any);
    setupFleet();
    const tools = runtimeFor('ceo').tools;
    expect(tools.fleet_status).toBeDefined();
    expect(tools.bot_spawn).toBeDefined();
    expect(tools.bot_retire).toBeDefined();

    const spawn = tools.bot_spawn as any;
    const out = await spawn.execute({ id: 'qa', name: 'QA', description: 'Reviews posts', persona: 'A meticulous QA reviewer who checks every claim.' }, {} as any);
    expect(out).toContain('qa');
    expect(store.get('qa')?.parent).toBe('ceo');

    let last = '';
    for (let i = 0; i < 5; i++) {
      last = await spawn.execute({ id: `filler${i}`, name: `F${i}`, description: 'x', persona: 'Filler persona for capacity testing purposes.' }, {} as any);
    }
    expect(last).toContain('crew cap');

    const retire = tools.bot_retire as any;
    expect(await retire.execute({ id: 'writer' }, {} as any)).toContain('retired');
    expect(store.get('writer')).toBeNull();
    // Ownership: ceo cannot retire another lead's crew
    store.create({ id: 'rival', name: 'Rival', manifest: { fleetRole: 'lead' } });
    manager.addCrew('rival', { id: 'guard', name: 'Guard' });
    expect(await retire.execute({ id: 'guard' }, {} as any)).toContain('is not crew');
  });

  it('bot_spawn does not block on persona refinement (refines in background)', async () => {
    mockedStreamText.mockClear();
    mockedGenerateText.mockReset();
    // refinePersona runs provider.generateText (the scripted stub, 'ok') —
    // the OBSERVABLE contract: the tool resolves to a created crew member
    // even while the background refinement is still pending, and the raw
    // persona is what lands at creation.
    const refineSpy = vi.spyOn(manager as unknown as { schedulePersonaRefinement: (id: string, name: string, raw: string) => void }, 'schedulePersonaRefinement');
    setupFleet();
    const tools = runtimeFor('ceo').tools;
    const spawn = tools.bot_spawn as any;
    const out = await spawn.execute({ id: 'bgqa', name: 'BGQA', description: 'Background-checks spawn latency', persona: 'A meticulous background QA reviewer persona, checked for spawn latency.' }, {} as any);
    expect(out).toContain('bgqa');
    expect(refineSpy).toHaveBeenCalledWith('bgqa', 'BGQA', expect.stringContaining('QA reviewer'));
    refineSpy.mockRestore();
    // The raw persona was stored at creation; background refinement (later
    // turns) overwrites via writePersona — buildTurn re-reads it each turn.
    expect(store.readPersona('bgqa')).toContain('QA');
  });

  it('multi-level fleets: a crew member can lead its own nested crew', () => {
    setupFleet();
    // Promote researcher to a mid-level lead (crew of ceo AND lead of scouts).
    store.update('researcher', m => { m.fleetRole = 'lead'; });
    manager.addCrew('researcher', { id: 'scout', name: 'Scout', persona: '# Scout\n\nScouts markets.' });
    expect(store.get('scout')?.parent).toBe('researcher');
    expect(store.crewOf('ceo').map(c => c.id)).toContain('researcher');
    expect(store.crewOf('researcher').map(c => c.id)).toEqual(['scout']);
    // Mid-level lead gets fleet tools AND its parent in the comms roster
    const rt = (manager as unknown as { getOrCreateRuntime(id: string, m: BotManifest): { tools: Record<string, any> } }).getOrCreateRuntime('researcher', store.get('researcher')!);
    expect(rt.tools.fleet_status).toBeDefined();
    expect(rt.tools.bot_spawn).toBeDefined();
    // Cycle/nesting guards: depth cap and ancestor rejection
    expect(manager.addCrew('scout', { id: 'ceo', name: 'Nope' })).toMatchObject({ ok: false });
    expect(manager.addCrew('scout', { id: 'scout', name: 'Self' })).toMatchObject({ ok: false });
  });

  it('hand-edited bot.yaml tools apply on the next build (no restart needed)', () => {
    store.create({ id: 'handedit', name: 'Handedit' });
    const before = runtimeFor('handedit').tools;
    expect(before.run_command).toBeUndefined(); // fail-closed default
    // External hand-edit: drop run_command from the deny list (explicit tools
    // block is respected as-written) + bump mtime.
    const file = join(root, 'bots', 'handedit', 'bot.yaml');
    writeFileSync(file, readFileSync(file, 'utf-8')
      .replace('    - run_command\n', ''), 'utf-8');
    utimesSync(file, new Date(), new Date());
    const after = runtimeFor('handedit').tools;
    expect(after.run_command).toBeDefined();
    expect(after.write_file).toBeUndefined(); // still denied
  });

  it('solo bots never get fleet tools', () => {
    store.create({ id: 'loner', name: 'Loner' });
    const tools = runtimeFor('loner').tools;
    expect(tools.fleet_status).toBeUndefined();
    expect(tools.bot_spawn).toBeUndefined();
  });
});

describe('bot_deliver — final artifact delivery', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-deliver-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
    store.get('researcher') ?? seedBot(store, 'researcher');
    mkdirSync(join(root, 'bots', '_shared'), { recursive: true });
    writeFileSync(join(root, 'bots', '_shared', 'final-report.md'), '# Final');
    mkdirSync(store.sandboxDir('researcher'), { recursive: true });
    writeFileSync(store.sandboxDir('researcher') + '/draft.md', 'draft body');
  });

  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('moves a shared-folder artifact into the owner-visible deliverables folder (work/ unless final)', () => {
    const sharedFile = join(root, 'bots', '_shared', 'final-report.md');
    const result = manager.deliver('researcher', sharedFile);
    expect(result.accepted).toBe(true);
    // Custom bots root → deliverables beside it, never the developer's Documents.
    expect(result.path).toContain(join(root, 'Mercury', 'RESEARCHER', 'work'));
    expect(result.path).toMatch(/\d{4}-\d{2}-\d{2} final report\.md$/);
    expect(existsSync(join(root, 'Mercury', 'RESEARCHER', 'README.md'))).toBe(true);
    expect(existsSync(sharedFile)).toBe(false); // a MOVE — the shared surface stays lean
    expect(existsSync(result.path!)).toBe(true);
  });

  it('rejects files outside the bot\'s writable roots (containment)', () => {
    writeFileSync(join(root, 'escape-me.md'), 'secret');
    const result = manager.deliver('researcher', join(root, 'escape-me.md'));
    expect(result.accepted).toBe(false);
    expect(result.reasonCode).toBe('outside_sandbox');
  });

  it('moves from the bot\'s private sandbox and dedupes delivered names', () => {
    const sandboxFile = join(store.sandboxDir('researcher'), 'draft.md');
    const first = manager.deliver('researcher', sandboxFile);
    expect(first.accepted).toBe(true);
    writeFileSync(sandboxFile, 'second body');
    const second = manager.deliver('researcher', sandboxFile);
    expect(second.accepted).toBe(true);
    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path!)).toBe(true);
    expect(existsSync(second.path!)).toBe(true);
  });
});

// ── ADR-020: governance ──────────────────────────────────────────────────────

describe('bot governance (ADR-020)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-gov-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager(root);
  });
  afterEach(() => {
    for (const m of activeManagers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  type StepOpts = { onStepFinish?: (step: { usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: unknown[]; toolResults?: unknown[] }) => void };
  const ok = (text = 'done') => ({ text, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }) as never;
  const completes = () => mockedGenerateText.mockImplementation(async () => ok());
  const stateOf = (botId: string) => manager.getStatusSummaries().find(s => s.id === botId)?.state;
  const waitIdle = (botId: string) => vi.waitFor(() => {
    expect(stateOf(botId)).not.toBe('running');
    expect(manager.getQueuedCount(botId)).toBe(0);
  });

  it('a cron tick is skipped while the bot is busy, and until the routine min-interval has passed', async () => {
    seedBot(store, 'ticker');
    let release!: () => void;
    mockedGenerateText.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(ok()); }));
    const first = manager.enqueue('ticker', { trigger: 'cron', prompt: 'cycle', routineId: 'bot:ticker:cycle' });
    expect(first.accepted).toBe(true);
    await vi.waitFor(() => expect(stateOf('ticker')).toBe('running'));
    // Busy → the tick is dropped, never stacked (the old behaviour queued it).
    expect(manager.enqueue('ticker', { trigger: 'cron', prompt: 'cycle v2', routineId: 'bot:ticker:cycle' })).toMatchObject({ accepted: false, reasonCode: 'busy' });
    // A delegated task is NOT a tick: it still queues behind the running turn.
    expect(manager.enqueue('ticker', { trigger: 'mailbox', prompt: 'please research X', fromBot: 'lead' }).accepted).toBe(true);
    completes();
    release();
    await waitIdle('ticker');
    // Finished → the next tick is still too soon (30-minute default gap).
    expect(manager.enqueue('ticker', { trigger: 'cron', prompt: 'cycle', routineId: 'bot:ticker:cycle' })).toMatchObject({ accepted: false, reasonCode: 'too_soon' });
    // A routine that declares a shorter gap in bot.yaml is honoured.
    store.update('ticker', m => { m.schedules = [{ name: 'fast', cron: '*/5 * * * *', prompt: 'x', minIntervalMinutes: 0 }]; });
    expect(manager.enqueue('ticker', { trigger: 'cron', prompt: 'x', routineId: 'bot:ticker:fast' }).accepted).toBe(true);
  });

  it('every bot gets the fleet default daily cap; 0 means unlimited; 80% warns once', async () => {
    seedBot(store, 'spender');
    const alerts: string[] = [];
    manager.setAlert(async (m) => { alerts.push(m); });
    expect(manager.dailyCapFor(store.get('spender')!)).toBe(5_000_000);
    store.update('spender', m => { m.autonomy = { dailyTokenBudget: 0 }; });
    expect(manager.dailyCapFor(store.get('spender')!)).toBe(0);
    store.update('spender', m => { m.autonomy = { dailyTokenBudget: 1000 }; });
    // Usage reaches the turn through onStepFinish (the SDK callback), not the result.
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => { opts.onStepFinish?.({ usage: { inputTokens: 800, outputTokens: 50 }, toolCalls: [], toolResults: [] }); return ok(); }) as never);
    manager.enqueue('spender', { trigger: 'chat', prompt: 'a' });
    await waitIdle('spender');
    expect(alerts.some(a => a.includes('85% of today'))).toBe(true);
    manager.enqueue('spender', { trigger: 'chat', prompt: 'b' });
    await waitIdle('spender');
    expect(alerts.some(a => a.includes('daily token budget reached'))).toBe(true);
    expect(manager.getStatusSummaries().find(s => s.id === 'spender')?.state).toBe('paused');
  });

  it('a work routine that produces nothing three runs in a row is paused, told once, and resumed by start', async () => {
    seedBot(store, 'writer');
    const alerts: string[] = [];
    manager.setAlert(async (m) => { alerts.push(m); });
    // Every run only writes a note into _shared — no deliverable, no action.
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      opts.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ toolName: 'write_file', toolCallId: 'w', input: { path: join(store.sharedSandboxDir(), 'record.md'), content: 'x' } }], toolResults: [{ toolCallId: 'w', output: { type: 'text', value: 'Wrote file' } }] });
      return ok('Record filed.');
    }) as never);
    store.update('writer', m => { m.schedules = [{ name: 'cycle', cron: '0 * * * *', prompt: 'cycle', minIntervalMinutes: 0 }]; });
    for (let i = 1; i <= 3; i++) {
      const r = manager.enqueue('writer', { trigger: 'cron', prompt: `cycle ${i}`, routineId: 'bot:writer:cycle' });
      expect(r.accepted).toBe(true);
      await waitIdle('writer');
    }
    const journal = manager.getJournal('writer', 5);
    expect(journal.map(r => r.outcome)).toEqual(['none', 'none', 'none']);
    expect(journal.every(r => r.claimedWithoutAction)).toBe(true);
    expect(journal[0].steps).toBeDefined();
    expect(journal[0].toolCalls).toBe(2); // the note, then the note again after the one nudge
    expect(journal[0].routineId).toBe('bot:writer:cycle');
    expect(store.readRoutineState('writer').paused['bot:writer:cycle']).toBeDefined();
    expect(alerts.filter(a => a.includes('is paused')).length).toBe(1);
    expect(manager.enqueue('writer', { trigger: 'cron', prompt: 'cycle 4', routineId: 'bot:writer:cycle' })).toMatchObject({ accepted: false, reasonCode: 'routine_paused' });
    manager.start('writer');
    expect(store.readRoutineState('writer').paused).toEqual({});
    expect(manager.enqueue('writer', { trigger: 'cron', prompt: 'cycle 5', routineId: 'bot:writer:cycle' }).accepted).toBe(true);
    await waitIdle('writer');
    // A completed-but-empty run is shown as such in the bot thread.
    const transcripts = readdirSync(join(store.botDir('writer'), 'transcripts'));
    expect(transcripts.length).toBe(4);
    expect(readFileSync(join(store.botDir('writer'), 'transcripts', transcripts[0]), 'utf-8')).toContain('"trace"');
  });

  it('a turn-limit stop is journaled as failed/turn_budget but is not an escalation', async () => {
    seedBot(store, 'big', { autonomy: { maxTokensPerTurn: 100 } });
    const alerts: string[] = [];
    manager.setAlert(async (m) => { alerts.push(m); });
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      opts.onStepFinish?.({ usage: { inputTokens: 500, outputTokens: 5 }, toolCalls: [], toolResults: [] });
      return ok('partial');
    }) as never);
    manager.enqueue('big', { trigger: 'chat', prompt: 'huge task' });
    await waitIdle('big');
    const [row] = manager.getJournal('big', 1);
    expect(row.state).toBe('failed');
    expect(row.reasonCode).toBe('turn_budget');
    expect(row.needsYou).toBeUndefined();
    expect(manager.getDlq('big')).toHaveLength(0);
    expect(alerts.some(a => a.includes('per-turn limit'))).toBe(true);
    expect(manager.getStatusSummaries().find(s => s.id === 'big')?.needsYou).toBe(false);
  });

  it('deliverables: human names, finals on top, crew under the lead folder, index, and legacy migration', () => {
    seedBot(store, 'lead', { fleetRole: 'lead' });
    store.update('lead', m => { m.name = 'Article Writer'; });
    manager.addCrew('lead', { id: 'fact-checker', name: 'Fact Checker' });
    const shared = store.sharedSandboxDir();
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'draft-c34-oxide-v2.md'), '# Oxide');
    writeFileSync(join(shared, 'checks.md'), '# checks');
    const final = manager.deliver('lead', join(shared, 'draft-c34-oxide-v2.md'), { title: 'Oxide Series D explained', final: true });
    expect(final.path).toMatch(/Mercury\/Article Writer\/\d{4}-\d{2}-\d{2} Oxide Series D explained\.md$/);
    const crew = manager.deliver('fact-checker', join(shared, 'checks.md'), { final: true });
    expect(crew.final).toBe(false); // crew never produce finals
    expect(crew.path).toMatch(/Mercury\/Article Writer\/work\/fact-checker\/\d{4}-\d{2}-\d{2} checks\.md$/);
    const index = readFileSync(join(store.deliverablesDir('lead'), 'README.md'), 'utf-8');
    expect(index).toContain('Oxide Series D explained.md');
    expect(index).toContain('work/');
    const listed = manager.listDeliverables('lead');
    expect(listed.map(d => d.final)).toEqual([true]);
    expect(manager.listDeliverables().map(d => d.botId).sort()).toEqual(['fact-checker', 'lead']);
    // Legacy outputs zone moves into the visible folder once.
    mkdirSync(join(store.outputsDir(), 'lead'), { recursive: true });
    writeFileSync(join(store.outputsDir(), 'lead', 'old-piece.md'), 'old');
    expect(manager.migrateDeliverables()).toEqual({ moved: 1 });
    expect(existsSync(join(store.deliverablesDir('lead'), 'work', 'old-piece.md'))).toBe(true);
    expect(existsSync(join(store.outputsDir(), 'README.md'))).toBe(true);
    expect(manager.migrateDeliverables()).toEqual({ moved: 0 });
  });

  it('the roster scan ignores profile copies inside sandbox/, outputs/ and other data dirs', () => {
    seedBot(store, 'real');
    // A bot "mirroring" its own profile into its sandbox and the outputs zone.
    for (const copy of [join(store.sandboxDir('real'), 'real'), join(store.outputsDir(), 'real')]) {
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, 'bot.yaml'), readFileSync(join(store.botDir('real'), 'bot.yaml')));
    }
    expect(store.list().map(m => m.id)).toEqual(['real']);
    expect(store.botDir('real')).toBe(join(root, 'bots', 'real'));
  });

  it('bot file tools resolve relative paths inside the bot workspace, not the daemon cwd', () => {
    seedBot(store, 'anchored');
    const registry = createBotCapabilityRegistry({
      botId: 'anchored', manifest: store.get('anchored')!, botDir: store.botDir('anchored'), permissions: {},
      config: getDefaultConfig() as MercuryConfig,
      sandbox: { workspace: store.sandboxDir('anchored'), shared: store.sharedSandboxDir() },
    });
    expect(registry.getCwd()).toBe(store.sandboxDir('anchored'));
  });
});
