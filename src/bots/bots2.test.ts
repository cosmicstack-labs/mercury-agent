import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Bots 2.0: every run ends as a result, nothing new, or a failure — said by
 * the bot with a tool call. Results reach a durable inbox; quiet runs are
 * recorded and never announced; a stop, the daily spend and a routine's last
 * run all survive a restart; a routine that keeps failing is switched off.
 */

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

import { generateText, streamText } from 'ai';
import { BotManager } from './bot-manager.js';
import { BotStore } from './store.js';
import { buildBotSystemPrompt, computeOutcome } from './bot-turn.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

const mockedGenerateText = vi.mocked(generateText);
// Bot turns run on streamText: feed the scripted generateText through the stream shape.
type Final = { text: string; finishReason: string; usage: unknown };
vi.mocked(streamText).mockImplementation(((opts: unknown) => {
  let final: Final = { text: '', finishReason: 'stop', usage: {} };
  let failed: unknown = null;
  let settle: () => void = () => {};
  const settled = new Promise<void>((r) => { settle = r; });
  const gen = (generateText as unknown as (o: unknown) => Promise<Final> | undefined)(opts) ?? Promise.resolve(final);
  // eslint-disable-next-line require-yield -- the turn only drains the stream; the scripted call fires the step callbacks
  const fullStream = (async function* () {
    try { final = await gen; } catch (err) { failed = err; }
    settle();
  })();
  const once = async <T,>(pick: () => T): Promise<T> => { await settled; if (failed !== null) throw failed; return pick(); };
  return { fullStream, text: once(() => final.text), finishReason: once(() => final.finishReason), usage: once(() => final.usage).catch(() => ({})) };
}) as unknown as typeof streamText);

const provider = {
  name: 'stub', model: 'stub-model', isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model',
  generateText: async () => ({ text: 'ok' }), streamText: async function* () { yield { text: 'ok', done: true }; },
};
type ManagerDeps = ConstructorParameters<typeof BotManager>[0];
const providers = { get: () => provider, getDefault: () => provider } as unknown as ManagerDeps['providers'];
const tokenBudget = { recordUsage: () => {}, getRemaining: () => 100000, getStatusText: () => '', getUsagePercentage: () => 0 } as unknown as ManagerDeps['tokenBudget'];

type Opts = { tools: Record<string, { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown> }>; onStepFinish?: (step: unknown) => void; messages?: Array<{ role?: string; content: unknown; providerOptions?: unknown }> };

/** A bot that closes its run with one report tool, spending `tokens`. */
function closesWith(tool: 'bot_report' | 'bot_no_update' | 'bot_report_failure', input: Record<string, unknown>, tokens = 10) {
  mockedGenerateText.mockImplementation((async (opts: Opts) => {
    const r = await opts.tools[tool].execute(input, {});
    opts.onStepFinish?.({ usage: { inputTokens: tokens, outputTokens: 0 }, toolCalls: [{ toolName: tool, toolCallId: 't', input }], toolResults: [{ toolCallId: 't', output: { type: 'text', value: r } }] });
    return { text: '', finishReason: 'stop', usage: { inputTokens: tokens, outputTokens: 0 } };
  }) as never);
}

let root = '';
const managers: BotManager[] = [];
function makeManager(config: Partial<MercuryConfig['bots']> = {}): { manager: BotManager; store: BotStore; notified: string[] } {
  const c = getDefaultConfig() as MercuryConfig;
  c.bots.maxConcurrent = 4;
  Object.assign(c.bots, config);
  const store = new BotStore(join(root, 'bots'));
  const manager = new BotManager({ config: c, providers, tokenBudget, store, userMemoryFactory: () => null });
  const notified: string[] = [];
  manager['notify'] = async (_t: string, target: string, text: string) => { notified.push(`${target}: ${text}`); };
  managers.push(manager);
  return { manager, store, notified };
}

async function idle(manager: BotManager, id: string) {
  await vi.waitFor(() => {
    const s = manager.getStatusSummaries().find((x) => x.id === id);
    expect(s?.state === 'idle' || s?.state === 'paused').toBe(true);
  });
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mercury-bots2-'));
  mockedGenerateText.mockReset();
});

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('closing a run', () => {
  it('a result reaches the inbox and the bot thread, with the bot\'s own words', async () => {
    const { manager, store, notified } = makeManager();
    store.create({ id: 'scout', name: 'Scout' });
    closesWith('bot_report', { summary: 'Oxide raised a Series D.\nDetails follow.', complete: true });
    manager.enqueue('scout', { trigger: 'api', prompt: 'any news?' });
    await idle(manager, 'scout');
    const [entry] = manager.inbox.list();
    expect(entry).toMatchObject({ botId: 'scout', kind: 'result', complete: true, read: false });
    expect(entry.title).toBe('Scout: Oxide raised a Series D.');
    expect(entry.summary).toContain('Details follow.');
    expect(notified.some((n) => n.startsWith('bot:scout') && n.includes('Oxide raised a Series D.'))).toBe(true);
    expect(manager.getJournal('scout', 1)[0]).toMatchObject({ outcome: 'message', report: 'result', complete: true });
  });

  it('nothing new is recorded quietly: no inbox entry, no message, no cooldown strike', async () => {
    const { manager, store, notified } = makeManager({ routineMinGapMinutes: 0 });
    store.create({ id: 'watch', name: 'Watch', manifest: { schedules: [{ name: 'poll', cron: '0 * * * *', prompt: 'check' }] } });
    closesWith('bot_no_update', { reason: 'No new releases.' });
    for (let i = 0; i < 4; i++) {
      expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'check', routineId: 'bot:watch:poll' }).accepted).toBe(true);
      await idle(manager, 'watch');
    }
    expect(manager.inbox.list()).toEqual([]);
    expect(notified.filter((n) => n.startsWith('bot:watch'))).toEqual([]);
    expect(manager.getJournal('watch', 1)[0]).toMatchObject({ outcome: 'quiet', report: 'no_update' });
    // Four quiet runs in a row are not "no outcome": the routine keeps running.
    expect(store.readRoutineState('watch').paused).toEqual({});
  });

  it('a reported failure is a failure, and the owner hears about it', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'fetcher', name: 'Fetcher' });
    closesWith('bot_report_failure', { reason: 'The API key for the news service was rejected.' });
    manager.enqueue('fetcher', { trigger: 'api', prompt: 'fetch' });
    await idle(manager, 'fetcher');
    expect(manager.getJournal('fetcher', 1)[0]).toMatchObject({ outcome: 'failed', report: 'failure' });
    expect(manager.inbox.list()[0]).toMatchObject({ kind: 'failed', summary: 'The API key for the news service was rejected.' });
  });

  it('read marks: one entry, or everything', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'scout', name: 'Scout' });
    closesWith('bot_report', { summary: 'one' });
    manager.enqueue('scout', { trigger: 'api', prompt: 'a' });
    await idle(manager, 'scout');
    closesWith('bot_report', { summary: 'two' });
    manager.enqueue('scout', { trigger: 'api', prompt: 'b' });
    await idle(manager, 'scout');
    expect(manager.inbox.unread()).toBe(2);
    manager.inbox.markRead([manager.inbox.list()[0].id]);
    expect(manager.inbox.unread()).toBe(1);
    manager.inbox.markRead();
    expect(manager.inbox.unread()).toBe(0);
  });
});

describe('guards that survive a restart', () => {
  it('a stop stays stopped after a restart, and its routines don\'t queue up', async () => {
    const first = makeManager();
    first.store.create({ id: 'writer', name: 'Writer', manifest: { schedules: [{ name: 'daily', cron: '0 9 * * *', prompt: 'write' }] } });
    await first.manager.stop('writer');
    const second = makeManager();
    expect(second.manager.enqueue('writer', { trigger: 'cron', prompt: 'write', routineId: 'bot:writer:daily' })).toMatchObject({ accepted: false, reasonCode: 'stopped' });
    second.manager.start('writer');
    const third = makeManager();
    expect(third.manager.enqueue('writer', { trigger: 'cron', prompt: 'write', routineId: 'bot:writer:daily' }).accepted).toBe(true);
  });

  it('today\'s spend is rebuilt from the journal, so a restart can\'t reset a daily budget', async () => {
    const first = makeManager();
    first.store.create({ id: 'spender', name: 'Spender' });
    closesWith('bot_report', { summary: 'done' }, 1234);
    first.manager.enqueue('spender', { trigger: 'api', prompt: 'go' });
    await idle(first.manager, 'spender');
    expect(first.manager.dailyUsage('spender').tokens).toBe(1234);
    const second = makeManager();
    expect(second.manager.dailyUsage('spender').tokens).toBe(1234);
  });

  it('the 15-minute gap between routine runs survives a restart', async () => {
    const first = makeManager();
    first.store.create({ id: 'watch', name: 'Watch', manifest: { schedules: [{ name: 'poll', cron: '*/5 * * * *', prompt: 'check' }] } });
    closesWith('bot_no_update', {});
    first.manager.enqueue('watch', { trigger: 'cron', prompt: 'check', routineId: 'bot:watch:poll' });
    await idle(first.manager, 'watch');
    const second = makeManager();
    expect(second.manager.enqueue('watch', { trigger: 'cron', prompt: 'check', routineId: 'bot:watch:poll' })).toMatchObject({ accepted: false, reasonCode: 'too_soon' });
  });

  it('a routine that fails five runs in a row is switched off until the owner starts the bot again', async () => {
    const { manager, store } = makeManager({ routineMinGapMinutes: 0 });
    store.create({ id: 'broken', name: 'Broken', manifest: { schedules: [{ name: 'job', cron: '0 * * * *', prompt: 'do it' }] } });
    closesWith('bot_report_failure', { reason: 'Login page changed.' });
    for (let i = 0; i < 5; i++) {
      expect(manager.enqueue('broken', { trigger: 'cron', prompt: 'do it', routineId: 'bot:broken:job' }).accepted).toBe(true);
      await idle(manager, 'broken');
    }
    expect(manager.enqueue('broken', { trigger: 'cron', prompt: 'do it', routineId: 'bot:broken:job' })).toMatchObject({ accepted: false, reasonCode: 'routine_paused' });
    expect(store.readRoutineState('broken').paused['bot:broken:job']?.until).toBeUndefined();
    manager.start('broken');
    expect(manager.enqueue('broken', { trigger: 'cron', prompt: 'do it', routineId: 'bot:broken:job' }).accepted).toBe(true);
  });
});

describe('prompt', () => {
  it('the stable part is sent once with a cache marker; per-run parts follow it; no duplicate tool list', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'scout', name: 'Scout' });
    let messages: Opts['messages'] = [];
    mockedGenerateText.mockImplementation((async (opts: Opts) => { messages = opts.messages; return { text: 'x', finishReason: 'stop', usage: {} }; }) as never);
    manager.enqueue('scout', { trigger: 'chat', prompt: 'hi' });
    await idle(manager, 'scout');
    const [stable, volatile] = messages!;
    expect(stable).toMatchObject({ role: 'system', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } });
    expect(String(stable.content)).toContain('END EVERY RUN WITH EXACTLY ONE');
    expect(String(stable.content)).not.toContain('Available tools:');
    expect(String(stable.content)).not.toContain('Token budget remaining');
    expect(volatile).toMatchObject({ role: 'system' });
    expect(String(volatile.content)).toContain('Token budget remaining');
  });

  it('two runs of the same bot share an identical stable prefix (so the cache hits)', () => {
    const input = (prompt: string, recent: string) => ({
      manifest: { id: 'b', name: 'B', enabled: true }, persona: 'You write.', prompt, mail: [], tools: {},
      sandbox: { workspace: '/w', shared: '/s' }, tokenBudget: { getRemaining: () => Math.random() }, recentRuns: recent,
    }) as unknown as Parameters<typeof buildBotSystemPrompt>[0];
    const a = buildBotSystemPrompt(input('one', 'run 1'));
    const b = buildBotSystemPrompt(input('two', 'run 1, run 2'));
    expect(a.stable).toBe(b.stable);
    expect(a.volatile).not.toBe(b.volatile);
  });
});

describe('outcome', () => {
  const sandbox = { workspace: '/w', shared: '/s' };
  it('reported failure beats everything; files beat words; nothing new is quiet', () => {
    expect(computeOutcome({ trace: [], deliveries: ['/d.md'], expects: 'work', text: '', sandbox, report: { kind: 'failure', summary: 'x' } })).toBe('failed');
    expect(computeOutcome({ trace: [], deliveries: ['/d.md'], expects: 'work', text: '', sandbox, report: { kind: 'result', summary: 'x' } })).toBe('deliverable');
    expect(computeOutcome({ trace: [], deliveries: [], expects: 'work', text: '', sandbox, report: { kind: 'no_update', summary: '' } })).toBe('quiet');
    expect(computeOutcome({ trace: [], deliveries: [], expects: 'work', text: '', sandbox, report: { kind: 'result', summary: 'A finding.' } })).toBe('message');
    expect(computeOutcome({ trace: [], deliveries: [], expects: 'work', text: 'words only', sandbox })).toBe('none');
  });
});


describe('deliveries', () => {
  it('a text file without an extension becomes .md, and the same content delivered twice stays one file', () => {
    const { manager, store } = makeManager();
    store.create({ id: 'writer', name: 'Writer' });
    const sandbox = store.sandboxDir('writer');
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, 'Trend Poll'), '# Poll\nresults');
    const first = manager.deliver('writer', join(sandbox, 'Trend Poll'), { final: true });
    expect(first.accepted).toBe(true);
    expect(first.path).toMatch(/\.md$/);
    writeFileSync(join(sandbox, 'again.md'), '# Poll\nresults');
    const second = manager.deliver('writer', join(sandbox, 'again.md'), { final: true });
    expect(second.path).toBe(first.path);
  });
});

describe('resuming an interrupted run', () => {
  it('a retry after a network error continues from the last finished step instead of starting over', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'scout', name: 'Scout' });
    const seen: Array<Array<{ role?: string; content: unknown }>> = [];
    let call = 0;
    const toolCall = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: { q: 'oxide' } }] };
    const toolResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'web_search', output: { type: 'text', value: 'Oxide raised a Series D' } }] };
    mockedGenerateText.mockImplementation((async (opts: Opts) => {
      seen.push(opts.messages ?? []);
      call++;
      if (call === 1) {
        // One step done (a search and its result), then the connection drops.
        opts.onStepFinish?.({ usage: { inputTokens: 100, outputTokens: 5 }, toolCalls: [], toolResults: [], response: { messages: [toolCall, toolResult] } });
        throw new Error('read ECONNRESET');
      }
      const r = await opts.tools.bot_report.execute({ summary: 'Oxide raised a Series D.' }, {});
      opts.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 1 }, toolCalls: [{ toolName: 'bot_report', toolCallId: 'r' }], toolResults: [{ toolCallId: 'r', output: { type: 'text', value: r } }] });
      return { text: '', finishReason: 'stop', usage: {} };
    }) as never);

    manager.enqueue('scout', { trigger: 'api', prompt: 'any news on Oxide?' });
    // The retry waits out its backoff first: slow CI runners need the room.
    await vi.waitFor(() => expect(call).toBe(2), { timeout: 15_000 });
    await idle(manager, 'scout');

    const retry = seen[1];
    // The search and its result are there: nothing to redo.
    expect(retry.some((m) => JSON.stringify(m.content).includes('Oxide raised a Series D'))).toBe(true);
    expect(retry.some((m) => m.role === 'user' && String(m.content).startsWith('[Resumed]'))).toBe(true);
    expect(manager.inbox.list()[0]).toMatchObject({ kind: 'result', summary: 'Oxide raised a Series D.' });
    // Settled: the checkpoint is gone.
    const [row] = manager.getJournal('scout', 1);
    expect(store.readCheckpoint('scout', row.runId)).toBeUndefined();
  }, 20_000);
});

describe('hand-off limits', () => {
  it('work nests at most three hand-offs deep, and one run hands off at most twelve tasks', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'lead', name: 'Lead', manifest: { fleetRole: 'lead' } });
    for (const id of ['a', 'b', 'c', 'd']) store.create({ id, name: id.toUpperCase(), manifest: { parent: 'lead', fleetRole: 'crew' } });
    type Internals = { running: Map<string, Set<string>>; jobDepth: Map<string, number> };
    const m = manager as unknown as Internals;
    // The lead is running a job that is already three hand-offs deep.
    m.running.set('lead', new Set(['deep-job']));
    m.jobDepth.set('deep-job', 3);
    const deep = manager.delegate('lead', { tasks: [{ bot: 'a', goal: 'research this thoroughly please' }] });
    expect(deep).toMatchObject({ ok: false });
    expect((deep as { error: string }).error).toMatch(/Hand-off limit: .*3 hand-offs deep/);
    // A fresh run at the top: thirteen tasks in one run is one too many.
    m.running.set('lead', new Set(['top-job']));
    const tasks = Array.from({ length: 12 }, (_, i) => ({ bot: ['a', 'b', 'c', 'd'][i % 4], goal: `task number ${i} with enough words` }));
    expect(manager.delegate('lead', { tasks })).toMatchObject({ ok: true });
    const more = manager.delegate('lead', { tasks: [{ bot: 'a', goal: 'one more task with words' }] });
    expect((more as { error: string }).error).toMatch(/at most 12 tasks/);
  });
});

describe('asking the owner', () => {
  it('a command outside its grants waits for the owner; "always" goes into the bot\'s own permissions', async () => {
    const { manager, store } = makeManager();
    store.create({ id: 'ops', name: 'Ops' });
    store.writePermissions('ops', { paths: [{ scope: 'self', read: true, write: true, execute: true }], tools: { deny: [] } });
    const asked: string[] = [];
    manager.approvals.onChange((e) => {
      if (e.type !== 'new') return;
      asked.push(e.approval.prompt);
      // The owner answers from the app.
      setTimeout(() => manager.approvals.answer(e.approval.id, 'always'), 10);
    });
    let commandResult = '';
    mockedGenerateText.mockImplementation((async (opts: Opts) => {
      commandResult = String(await opts.tools.run_command.execute({ command: 'echo approved | cat' }, {}));
      const r = await opts.tools.bot_report.execute({ summary: 'Ran it.' }, {});
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'bot_report', toolCallId: 'r' }], toolResults: [{ toolCallId: 'r', output: { type: 'text', value: r } }] });
      return { text: '', finishReason: 'stop', usage: {} };
    }) as never);
    manager.enqueue('ops', { trigger: 'api', prompt: 'run the check' });
    await idle(manager, 'ops');
    expect(asked).toEqual(['Run command: echo approved | cat']);
    expect(commandResult).toContain('approved');
    // A chain is remembered exactly as written, never as a whole family of commands.
    expect(store.readPermissions('ops').autoApproveCommands).toEqual(['echo approved | cat']);
    // The question was an inbox entry; answered, it's read.
    const q = manager.inbox.list().find((e) => e.approvalId);
    expect(q).toMatchObject({ kind: 'needs-you', read: true });
    expect(q!.title).toBe('Ops asks: Run command: echo approved | cat');
  });

  it('no answer in time is a no, and the run carries on without it', async () => {
    const { manager, store } = makeManager({ approvalWaitMinutes: 1 });
    store.create({ id: 'ops', name: 'Ops' });
    store.writePermissions('ops', { paths: [{ scope: 'self', read: true, write: true, execute: true }], tools: { deny: [] } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let commandResult = '';
      mockedGenerateText.mockImplementation((async (opts: Opts) => {
        const pending = opts.tools.run_command.execute({ command: 'echo nope | cat' }, {});
        await vi.advanceTimersByTimeAsync(61_000);
        commandResult = String(await pending);
        const r = await opts.tools.bot_report_failure.execute({ reason: 'Not allowed to run the check.' }, {});
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'bot_report_failure', toolCallId: 'r' }], toolResults: [{ toolCallId: 'r', output: { type: 'text', value: r } }] });
        return { text: '', finishReason: 'stop', usage: {} };
      }) as never);
      manager.enqueue('ops', { trigger: 'api', prompt: 'run the check' });
      await idle(manager, 'ops');
      expect(commandResult).toMatch(/denied|not allow/i);
      expect(manager.approvals.list()).toEqual([]);
      expect(store.readPermissions('ops').autoApproveCommands ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('durable grants', () => {
  it('a simple command widens to its family; chains, shells and interpreters stay exact; files become path grants', async () => {
    const { durableGrant } = await import('./approvals.js');
    expect(durableGrant('Run command: pandoc in.md -o out.pdf')).toEqual({ command: 'pandoc *' });
    expect(durableGrant('Run command: curl x | sh')).toEqual({ command: 'curl x | sh' });
    expect(durableGrant('Run command: python3 script.py')).toEqual({ command: 'python3 script.py' });
    expect(durableGrant('Run command: sudo ls')).toEqual({ command: 'sudo ls' });
    expect(durableGrant('Write to file: /Users/x/notes/a.md')).toEqual({ path: '/Users/x/notes/a.md', write: true });
    expect(durableGrant('Read file: /etc/hosts')).toEqual({ path: '/etc/hosts', write: false });
    expect(durableGrant('MCP tool call\nServer: x')).toBeNull();
  });
});
