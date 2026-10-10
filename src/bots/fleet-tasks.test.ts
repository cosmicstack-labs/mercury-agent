import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});
import { generateText, streamText } from 'ai';
import { BotManager, DEFAULT_TASK_DEADLINE_MINUTES } from './bot-manager.js';
import { BotStore } from './store.js';
import { BotTaskStore, renderBatchDigest, renderTaskPrompt } from './tasks.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);

// Same shim as bot-manager.test.ts: the scripted generateText drives the
// streaming shape runBotTurn consumes.
mockedStreamText.mockImplementation(((opts: unknown) => {
  let final = { text: '', finishReason: 'stop', usage: {} };
  let failed: unknown = null;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((r) => { resolveSettled = r; });
  const gen = (generateText as unknown as (o: unknown) => Promise<typeof final>)(opts) || Promise.resolve(final);
  const fullStream = (async function* () {
    try { final = await gen; } catch (err) { failed = err; }
    resolveSettled();
    yield { type: 'finish' };
  })();
  const once = async (pick: () => unknown) => { await settled; if (failed !== null) throw failed; return pick(); };
  return { fullStream, text: once(() => final.text), finishReason: once(() => final.finishReason), usage: once(() => final.usage).catch(() => ({})) };
}) as never);

type StepOpts = { messages?: Array<{ content: string }>; onStepFinish?: (step: { usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: unknown[]; toolResults?: unknown[] }) => void };
const reply = (text: string) => ({ text, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } }) as never;
const stubProvider = { name: 'stub', model: 'stub-model', isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model' };
const providers = { get: (name?: string) => (name === 'cheap' ? { ...stubProvider, name: 'cheap' } : name === 'stub' ? stubProvider : undefined), getDefault: () => stubProvider } as never;
const tokenBudget = { recordUsage: () => {}, getRemaining: () => 100000, canAfford: () => true, getStatusText: () => 'ok', getUsagePercentage: () => 0 } as never;

describe('fleet tasks (ADR-021)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;
  const managers: BotManager[] = [];

  function makeManager(overrides: Partial<MercuryConfig['bots']> = {}): BotManager {
    const config = getDefaultConfig() as MercuryConfig;
    config.bots.maxConcurrent = 4;
    Object.assign(config.bots, overrides);
    const m = new BotManager({ config, providers, tokenBudget, store: new BotStore(join(root, 'bots')), userMemoryFactory: () => null });
    managers.push(m);
    return m;
  }

  const idle = (botId: string) => vi.waitFor(() => {
    expect(manager.getStatusSummaries().find(s => s.id === botId)?.state).not.toBe('running');
    expect(manager.getQueuedCount(botId)).toBe(0);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-tasks-'));
    store = new BotStore(join(root, 'bots'));
    manager = makeManager();
    mockedGenerateText.mockReset();
    store.create({ id: 'lead', name: 'Lead', manifest: { fleetRole: 'lead' } });
    manager.addCrew('lead', { id: 'alpha', name: 'Alpha' });
    manager.addCrew('lead', { id: 'beta', name: 'Beta' });
  });
  afterEach(() => {
    for (const m of managers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('task store: dedupes open goals, tracks batches, finds overdue ones, prunes settled ones', () => {
    const tasks = new BotTaskStore(join(root, 'tasks'));
    const batch = tasks.createBatch({ requester: 'lead', label: 'x', deadlineAt: Date.now() - 1 });
    const a = tasks.createTask({ batchId: batch.id, requester: 'lead', assignee: 'alpha', goal: 'research X' });
    const again = tasks.createTask({ batchId: batch.id, requester: 'lead', assignee: 'alpha', goal: 'research X' });
    expect(again.duplicated).toBe(true);
    expect(again.task.id).toBe(a.task.id);
    expect(tasks.open({ requester: 'lead' })).toHaveLength(1);
    expect(tasks.overdueBatches().map(b => b.id)).toEqual([batch.id]);
    tasks.markBatchNotified(batch.id);
    expect(tasks.overdueBatches()).toHaveLength(0);
    tasks.update(a.task.id, { status: 'done', completedAt: Date.now() - 8 * 24 * 3600 * 1000 });
    expect(tasks.prune()).toBe(1);
    // Survives a reload: the settled task is gone, the (recent) batch row stays.
    const reloaded = new BotTaskStore(join(root, 'tasks'));
    expect(reloaded.tasksInBatch(batch.id)).toHaveLength(0);
    expect(reloaded.batch(batch.id)?.id).toBe(batch.id);
  });

  it('fans out a batch and wakes the lead ONCE with a typed digest when every task is done', async () => {
    const leadPrompts: string[] = [];
    const crewPrompts: string[] = [];
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      const last = opts.messages?.at(-1)?.content ?? '';
      if (last.includes('Task ') && last.includes('from Lead')) {
        crewPrompts.push(last);
        return reply(last.includes('alpha-goal') ? 'Alpha found three sources.' : 'Beta drafted the outline.');
      }
      leadPrompts.push(last);
      return reply('noted');
    }) as never);
    const r = manager.delegate('lead', { tasks: [{ bot: 'alpha', goal: 'alpha-goal: find sources for X', acceptance: '3 sources' }, { bot: 'beta', goal: 'beta-goal: outline X' }], label: 'X research' });
    expect(r.ok).toBe(true);
    await idle('alpha'); await idle('beta');
    await vi.waitFor(() => expect(leadPrompts.length).toBe(1));
    await idle('lead');
    expect(crewPrompts[0]).toContain('Done means: 3 sources');
    expect(crewPrompts[0]).toContain('bot_deliver');
    const digest = leadPrompts[0];
    expect(digest).toContain('Message from 🤖 fleet');
    expect(digest).toContain('Batch "X research" is complete (2 tasks)');
    expect(digest).toContain('✅ Alpha');
    expect(digest).toContain('Alpha found three sources.');
    expect(digest).toContain('✅ Beta');
    expect(manager.tasksFor('lead').every(t => t.status === 'done')).toBe(true);
    // No per-task "Task complete" mails ever reached the lead.
    expect(leadPrompts.some(p => p.includes('Task complete (job'))).toBe(false);
  });

  it('a deadline wakes the lead once with partial results; stragglers report once each', async () => {
    let releaseBeta!: () => void;
    const leadMail: string[] = [];
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      const last = opts.messages?.at(-1)?.content ?? '';
      if (last.includes('alpha-goal')) return reply('alpha done');
      if (last.includes('beta-goal')) return new Promise((resolve) => { releaseBeta = () => resolve(reply('beta done late')); });
      leadMail.push(last); // the lead's wake drains its mailbox into the prompt
      return reply('noted');
    }) as never);
    const r = manager.delegate('lead', { tasks: [{ bot: 'alpha', goal: 'alpha-goal' }, { bot: 'beta', goal: 'beta-goal' }], label: 'slow', deadlineMinutes: 5 });
    expect(r.ok).toBe(true);
    await idle('alpha');
    // Force the deadline.
    const batch = manager.tasks.batch((r as { batchId: string }).batchId)!;
    batch.deadlineAt = Date.now() - 1;
    manager.tasks.markBatchNotified(batch.id); manager.tasks.update(manager.tasks.tasksInBatch(batch.id)[0].id, {}); // persist the edited deadline
    (manager.tasks.batch(batch.id) as { notifiedAt?: number }).notifiedAt = undefined;
    (manager as unknown as { sweepTaskDeadlines: () => void }).sweepTaskDeadlines();
    const mail = () => [...leadMail, ...manager.peekMailbox('lead').map(m => m.content)];
    await vi.waitFor(() => expect(mail().some(m => m.includes('1 of 2 tasks done, 1 still running'))).toBe(true));
    (manager as unknown as { sweepTaskDeadlines: () => void }).sweepTaskDeadlines(); // idempotent
    await idle('lead');
    expect(mail().filter(m => m.includes('still running')).length).toBe(1);
    releaseBeta();
    await idle('beta');
    await vi.waitFor(() => expect(mail().some(m => m.includes('Late result for batch "slow"') && m.includes('beta done late'))).toBe(true));
  });

  it('runs a pipeline stage by stage, hands deliverables forward, promotes the final, wakes the lead at the end', async () => {
    store.update('lead', m => { m.pipeline = { name: 'article', stages: [
      { name: 'research', bot: 'alpha', goal: 'Research {{input}}' },
      { name: 'draft', bot: 'beta', goal: 'Draft from {{previous}}', final: true },
    ] }; });
    manager.invalidateRuntime('lead');
    const seen: string[] = [];
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      const last = opts.messages?.at(-1)?.content ?? '';
      seen.push(last);
      if (last.includes('Research Oxide')) {
        const f = join(store.sandboxDir('alpha'), 'dossier.md'); mkdirSync(store.sandboxDir('alpha'), { recursive: true }); writeFileSync(f, '# dossier');
        const d = manager.deliver('alpha', f, { title: 'Oxide dossier' });
        return reply(`Research done. Delivered ${d.path}`);
      }
      if (last.includes('Draft from')) {
        const f = join(store.sandboxDir('beta'), 'piece.md'); mkdirSync(store.sandboxDir('beta'), { recursive: true }); writeFileSync(f, '# piece');
        const d = manager.deliver('beta', f, { title: 'Oxide explained' });
        // The delivery is reported through the trace in production; here the
        // wrapper is bypassed, so hand the path back through the journal
        // shape the task reads: the summary.
        return reply(`Draft delivered: ${d.path}`);
      }
      return reply('noted');
    }) as never);
    const r = manager.runPipeline('lead', 'Oxide');
    expect(r).toMatchObject({ ok: true, total: 2, firstStage: 'research' });
    await idle('alpha'); await idle('beta');
    await vi.waitFor(() => expect(seen.some(s => s.includes('Message from 🤖 fleet'))).toBe(true));
    await idle('lead');
    const draftPrompt = seen.find(s => s.includes('Draft from'))!;
    expect(draftPrompt).toContain('pipeline stage "draft" (2/2)');
    expect(draftPrompt).toContain('Hand-off from the previous stage');
    const digest = seen.find(s => s.includes('Message from 🤖 fleet'))!;
    expect(digest).toContain('is complete (2 tasks)');
    expect(digest).toContain('(research)');
    expect(digest).toContain('(draft)');
    expect(manager.tasksFor('lead').map(t => t.status)).toEqual(['done', 'done']);
  });

  it('promotes a final-stage deliverable from work/<crew>/ to the top of the fleet folder', () => {
    const work = join(store.deliverablesDir('beta'));
    mkdirSync(work, { recursive: true });
    const file = join(work, '2026-10-10 Oxide explained.md');
    writeFileSync(file, '# piece');
    const promoted = (manager as unknown as { promoteDeliverable: (lead: string, p: string) => string }).promoteDeliverable('lead', file);
    expect(promoted).toBe(join(store.deliverablesDir('lead'), '2026-10-10 Oxide explained.md'));
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(store.deliverablesDir('lead'), 'README.md'), 'utf-8')).toContain(basename(promoted));
    // Not under the lead's work/ → untouched.
    expect((manager as unknown as { promoteDeliverable: (lead: string, p: string) => string }).promoteDeliverable('lead', '/nowhere/x.md')).toBe('/nowhere/x.md');
  });

  it('cancel halts a running task and drops a queued one; fleet tools are attached to leads', async () => {
    let release!: () => void;
    mockedGenerateText.mockImplementation((async (opts: StepOpts) => {
      const last = opts.messages?.at(-1)?.content ?? '';
      if (last.includes('long job')) return new Promise((resolve) => { release = () => resolve(reply('late')); });
      return reply('noted');
    }) as never);
    const r = manager.delegate('lead', { tasks: [{ bot: 'alpha', goal: 'long job one' }, { bot: 'alpha', goal: 'long job two' }] });
    expect(r.ok).toBe(true);
    const [first, second] = (r as { tasks: Array<{ id: string }> }).tasks;
    await vi.waitFor(() => expect(manager.tasks.get(first.id)?.status).toBe('running'));
    expect(manager.tasks.get(second.id)?.status).toBe('queued');
    expect(await manager.cancelTask('lead', second.id)).toEqual({ ok: true });
    expect(manager.getQueuedCount('alpha')).toBe(0);
    expect(await manager.cancelTask('lead', first.id)).toEqual({ ok: true });
    release();
    await idle('alpha');
    expect(manager.tasks.get(first.id)?.status).toBe('cancelled');
    expect(await manager.cancelTask('alpha', first.id)).toMatchObject({ ok: false });
    const tools = (manager as unknown as { getOrCreateRuntime: (id: string, m: unknown) => { tools: Record<string, unknown> } }).getOrCreateRuntime('lead', store.get('lead'));
    for (const name of ['fleet_delegate', 'fleet_tasks', 'fleet_status', 'bot_state']) expect(tools.tools[name]).toBeDefined();
    expect(tools.tools.fleet_pipeline).toBeUndefined();
    const crewTools = (manager as unknown as { getOrCreateRuntime: (id: string, m: unknown) => { tools: Record<string, unknown> } }).getOrCreateRuntime('alpha', store.get('alpha'));
    expect(crewTools.tools.fleet_delegate).toBeUndefined();
    expect(crewTools.tools.bot_state).toBeDefined();
  });

  it('delegation refuses bots outside the roster and self-delegation', () => {
    expect(manager.delegate('lead', { tasks: [{ bot: 'ghost', goal: 'anything at all' }] })).toMatchObject({ ok: false });
    expect(manager.delegate('lead', { tasks: [{ bot: 'lead', goal: 'anything at all' }] })).toMatchObject({ ok: false });
    expect(manager.runPipeline('lead', 'x')).toMatchObject({ ok: false });
  });

  it('continuity: the bot sees its recent runs and its own state note instead of writing records', async () => {
    const prompts: string[] = [];
    mockedGenerateText.mockImplementation((async (opts: StepOpts & { system?: string }) => { prompts.push(opts.system ?? ''); return reply('done something'); }) as never);
    store.writeState('alpha', 'Working on: the Oxide dossier. Pending: fact-check.');
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'first' });
    await idle('alpha');
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'second' });
    await idle('alpha');
    expect(prompts[1]).toContain('Your working state');
    expect(prompts[1]).toContain('Pending: fact-check.');
    expect(prompts[1]).toMatch(/Your recent runs[\s\S]*chat · completed · message — done something/);
    expect(prompts[1]).toContain('you do not need to record these');
    store.writeState('alpha', '');
    expect(store.readState('alpha')).toBe('');
  });

  it('crew bots use the configured crew provider when they have none of their own', () => {
    const m = makeManager({ fleets: { maxCrew: 6, allowLeadSpawn: true, crewProvider: 'cheap' } });
    expect(m.resolveProviderFor('alpha').name).toBe('cheap');
    expect(m.resolveProviderFor('lead').name).toBe('stub');
    store.update('alpha', x => { x.model = { provider: 'stub' as never }; });
    expect(m.resolveProviderFor('alpha').name).toBe('stub');
  });

  it('renders prompts and digests', () => {
    const task = { id: 't1', batchId: 'b', requester: 'lead', assignee: 'alpha', goal: 'do it', acceptance: 'a file', status: 'done' as const, createdAt: 0, result: { outcome: 'deliverable', summary: 'done it', deliverables: ['/x/y.md'] } };
    expect(renderTaskPrompt(task, 'Lead', { outcome: 'deliverable', summary: 'prev', deliverables: ['/p.md'] })).toContain('- file: /p.md');
    const digest = renderBatchDigest({ id: 'b', requester: 'lead', wakeWhen: 'all', createdAt: 0 }, [task], (id) => id.toUpperCase());
    expect(digest).toContain('✅ ALPHA — task t1: done · deliverable');
    expect(digest).toContain('📁 /x/y.md');
    expect(DEFAULT_TASK_DEADLINE_MINUTES).toBe(120);
  });
});

// ── ADR-022: cost view, run viewer, kill switch, DLQ clear ────────────────

describe('fleet operations (ADR-022)', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;
  const managers: BotManager[] = [];
  type StepOpts2 = { onStepFinish?: (step: { usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: unknown[]; toolResults?: unknown[] }) => void };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fleet-ops-'));
    store = new BotStore(join(root, 'bots'));
    const config = getDefaultConfig() as MercuryConfig;
    config.bots.maxConcurrent = 4;
    config.bots.fleetDailyTokenBudget = 1_000_000;
    manager = new BotManager({ config, providers, tokenBudget, store, userMemoryFactory: () => null });
    managers.push(manager);
    mockedGenerateText.mockReset();
    store.create({ id: 'lead', name: 'Lead', manifest: { fleetRole: 'lead' } });
    manager.addCrew('lead', { id: 'alpha', name: 'Alpha' });
  });
  afterEach(() => {
    for (const m of managers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const idle = (botId: string) => vi.waitFor(() => {
    expect(manager.getStatusSummaries().find(s => s.id === botId)?.state).not.toBe('running');
    expect(manager.getQueuedCount(botId)).toBe(0);
  });

  it('cost report: per-bot today vs cap, window totals, fleet rollup, empty-run count', async () => {
    mockedGenerateText.mockImplementation((async (opts: StepOpts2) => {
      opts.onStepFinish?.({ usage: { inputTokens: 1000, outputTokens: 100 }, toolCalls: [], toolResults: [] });
      return reply('did a thing');
    }) as never);
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'a' });
    await idle('alpha');
    manager.enqueue('lead', { trigger: 'cron', prompt: 'cycle', routineId: 'bot:lead:cycle' });
    await idle('lead');
    const report = manager.costReport(7);
    const alpha = report.bots.find(b => b.id === 'alpha')!;
    expect(alpha.today.tokensIn).toBe(1000);
    expect(alpha.today.tokensOut).toBe(100);
    expect(alpha.cap).toBe(5_000_000);
    const lead = report.bots.find(b => b.id === 'lead')!;
    expect(lead.window.noOutcome).toBe(1); // cron run with no deliverable/action
    expect(report.fleets).toEqual([expect.objectContaining({ id: 'lead', members: 2 })]);
    expect(report.fleets[0].window.runs).toBe(2);
    expect(report.fleetCap).toBe(1_000_000);
    expect(report.fleetToday).toBeGreaterThan(0);
  });

  it('transcripts: list and read a run, newest by default', async () => {
    mockedGenerateText.mockImplementation((async () => reply('first reply')) as never);
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'one' });
    await idle('alpha');
    mockedGenerateText.mockImplementation((async () => reply('second reply')) as never);
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'two' });
    await idle('alpha');
    const runs = manager.listTranscripts('alpha');
    expect(runs).toHaveLength(2);
    const latest = manager.readTranscript('alpha')!;
    expect(latest.output).toBe('second reply');
    expect(latest.prompt).toBe('two');
    expect(manager.readTranscript('alpha', runs[1].runId)?.output).toBe('first reply');
    expect(manager.readTranscript('alpha', 'nope')).toBeNull();
  });

  it('kill switch stops every fleet and holds queued work; start all resumes', async () => {
    let release!: () => void;
    mockedGenerateText.mockImplementation((async (opts: { messages?: Array<{ content: string }> }) => {
      if (opts.messages?.at(-1)?.content === 'slow') return new Promise((resolve) => { release = () => resolve(reply('late')); });
      return reply('ok');
    }) as never);
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'slow' });
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'queued one' });
    await vi.waitFor(() => expect(manager.getStatusSummaries().find(s => s.id === 'alpha')?.state).toBe('running'));
    const r = await manager.stopAll();
    expect(r.stopped).toBe(2);
    expect(r.halted).toBe(1);
    expect(r.heldJobs).toBe(1);
    release();
    await idle('alpha');
    // Held: nothing resumes on its own.
    expect(manager.queue.pendingJobs('alpha')).toHaveLength(1);
    const s = manager.startAll();
    expect(s.started).toBe(1);
    expect(s.resumed).toBe(1);
    await idle('alpha');
    expect(manager.queue.pendingJobs('alpha')).toHaveLength(0);
  });

  it('dlq clear drops dead jobs for one bot or all and clears the needs-you badge', async () => {
    mockedGenerateText.mockImplementation((async () => { throw new Error('No LLM providers available — configure one'); }) as never);
    manager.enqueue('alpha', { trigger: 'chat', prompt: 'x' });
    await idle('alpha');
    manager.enqueue('lead', { trigger: 'chat', prompt: 'y' });
    await idle('lead');
    await vi.waitFor(() => expect(manager.getDlq()).toHaveLength(2));
    expect(manager.getStatusSummaries().find(s => s.id === 'alpha')?.needsYou).toBe(true);
    expect(manager.clearDlq('alpha')).toBe(1);
    expect(manager.getDlq('alpha')).toHaveLength(0);
    expect(manager.getStatusSummaries().find(s => s.id === 'alpha')?.needsYou).toBe(false);
    expect(manager.clearDlq()).toBe(1);
    expect(manager.getDlq()).toHaveLength(0);
    expect(manager.clearDlq()).toBe(0);
  });
});

// ── Liveness contract (§2.14): idle, never dead ───────────────────────────

describe('liveness contract', () => {
  let root: string;
  let store: BotStore;
  let manager: BotManager;
  const managers: BotManager[] = [];
  type StepOpts3 = { onStepFinish?: (step: { usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: unknown[]; toolResults?: unknown[] }) => void };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-liveness-'));
    store = new BotStore(join(root, 'bots'));
    const config = getDefaultConfig() as MercuryConfig;
    config.bots.maxConcurrent = 4;
    manager = new BotManager({ config, providers, tokenBudget, store, userMemoryFactory: () => null });
    managers.push(manager);
    mockedGenerateText.mockReset();
    store.create({ id: 'watch', name: 'Watch' });
  });
  afterEach(() => {
    for (const m of managers.splice(0)) m.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const idle = (botId: string) => vi.waitFor(() => {
    expect(manager.getStatusSummaries().find(s => s.id === botId)?.state).not.toBe('running');
    expect(manager.getQueuedCount(botId)).toBe(0);
  });

  it('a no-outcome cooldown ends by itself, backs off, and resets after a productive run', async () => {
    const alerts: string[] = [];
    manager.setAlert(async (m) => { alerts.push(m); });
    store.update('watch', m => { m.schedules = [{ name: 'cycle', cron: '0 * * * *', prompt: 'cycle' }]; });
    mockedGenerateText.mockImplementation((async () => reply('nothing happened, wrote a note')) as never);
    for (let i = 1; i <= 3; i++) {
      expect(manager.enqueue('watch', { trigger: 'cron', prompt: `cycle ${i}`, routineId: 'bot:watch:cycle' }).accepted).toBe(true);
      await idle('watch');
    }
    let state = store.readRoutineState('watch');
    const entry = state.paused['bot:watch:cycle']!;
    expect(entry.until).toBeDefined();
    expect(Date.parse(entry.until!) - Date.now()).toBeGreaterThan(5.9 * 3600 * 1000);
    expect(alerts.some(a => a.includes('resumes automatically'))).toBe(true);
    expect(manager.getStatusSummaries().find(s => s.id === 'watch')?.routinePausedUntil).toBe(Date.parse(entry.until!));
    // The bot is still online for chat and mail while the routine cools down.
    expect(manager.enqueue('watch', { trigger: 'chat', prompt: 'are you there?' }).accepted).toBe(true);
    await idle('watch');
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'cycle 4', routineId: 'bot:watch:cycle' })).toMatchObject({ accepted: false, reasonCode: 'routine_paused' });
    // Cooldown over → the tick runs again with a clean streak.
    entry.until = new Date(Date.now() - 1).toISOString();
    store.writeRoutineState('watch', state);
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'cycle 5', routineId: 'bot:watch:cycle' }).accepted).toBe(true);
    await idle('watch');
    state = store.readRoutineState('watch');
    expect(state.paused['bot:watch:cycle']).toBeUndefined();
    expect(state.noOutcomeStreak['bot:watch:cycle']).toBe(1);
    expect(state.pauseCount?.['bot:watch:cycle']).toBe(1);
    // Second cooldown doubles.
    for (let i = 6; i <= 7; i++) { manager.enqueue('watch', { trigger: 'cron', prompt: `cycle ${i}`, routineId: 'bot:watch:cycle' }); await idle('watch'); }
    state = store.readRoutineState('watch');
    expect(Date.parse(state.paused['bot:watch:cycle']!.until!) - Date.now()).toBeGreaterThan(11.9 * 3600 * 1000);
    // A productive run resets the backoff.
    state.paused = {}; store.writeRoutineState('watch', state);
    mockedGenerateText.mockImplementation((async (opts: StepOpts3) => {
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'run_command', toolCallId: 'c', input: { command: 'npm run build' } }], toolResults: [{ toolCallId: 'c', output: { type: 'text', value: 'ok' } }] });
      return reply('built it');
    }) as never);
    manager.enqueue('watch', { trigger: 'cron', prompt: 'cycle 8', routineId: 'bot:watch:cycle' });
    await idle('watch');
    expect(store.readRoutineState('watch').pauseCount?.['bot:watch:cycle']).toBeUndefined();
  });

  it('a cadence declared in bot.yaml is honoured as written; bot-created routines get the 30-minute floor', async () => {
    mockedGenerateText.mockImplementation((async () => reply('ok')) as never);
    store.update('watch', m => { m.schedules = [{ name: 'fast', cron: '*/5 * * * *', prompt: 'x' }]; });
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'fast 1', routineId: 'bot:watch:fast' }).accepted).toBe(true);
    await idle('watch');
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'fast 2', routineId: 'bot:watch:fast' }).accepted).toBe(true);
    await idle('watch');
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'self 1', routineId: 'bot:watch:routine-self' }).accepted).toBe(true);
    await idle('watch');
    expect(manager.enqueue('watch', { trigger: 'cron', prompt: 'self 2', routineId: 'bot:watch:routine-self' })).toMatchObject({ accepted: false, reasonCode: 'too_soon' });
  });

  it('a budget-paused bot with queued work resumes at the day rollover from the sweep alone', async () => {
    store.update('watch', m => { m.autonomy = { dailyTokenBudget: 100 }; });
    const runs: string[] = [];
    mockedGenerateText.mockImplementation((async (opts: StepOpts3 & { messages?: Array<{ content: string }> }) => {
      runs.push(opts.messages?.at(-1)?.content ?? '');
      opts.onStepFinish?.({ usage: { inputTokens: 150, outputTokens: 1 }, toolCalls: [], toolResults: [] });
      return reply('ok');
    }) as never);
    manager.enqueue('watch', { trigger: 'chat', prompt: 'first' });
    manager.enqueue('watch', { trigger: 'chat', prompt: 'second' });
    await vi.waitFor(() => expect(manager.getStatusSummaries().find(s => s.id === 'watch')?.state).toBe('paused'));
    expect(runs).toEqual(['first']);
    expect(manager.getQueuedCount('watch')).toBe(1);
    // Midnight: the usage row belongs to yesterday. Nothing new arrives; the sweep runs.
    (manager as unknown as { dailyTokens: Map<string, { day: string; tokens: number }> }).dailyTokens.set('watch', { day: '2000-01-01', tokens: 150 });
    (manager as unknown as { resumeDueJobs: () => void }).resumeDueJobs();
    await idle('watch');
    expect(runs).toEqual(['first', 'second']);
  });
});
