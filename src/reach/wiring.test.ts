import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempHome } from '../plugins/test-fixtures.js';
import { activeCallScheduler, pluginCallScheduler, registerCallScheduler, CallScheduler } from '../plugins/call-schedule.js';
import { publishTool, resetToolBridge } from '../plugins/tool-bridge.js';
import { _resetPresence } from './presence.js';
import { ReachService } from './service.js';
import { listMissed } from './missed.js';
import { writeReachSettings } from './settings.js';
import { LONG_TASK_MS, onBackgroundTaskDone, onBotInboxEntry, setupPhoneReach, whatsappCaller } from './wiring.js';
import { createDevice } from '../web/devices.js';
import type { BotInboxEntry } from '../bots/inbox.js';
import type { BackgroundTask } from '../core/background-tasks.js';

/**
 * "Call me at 9pm" through the Mercury app (ADR-046): the phone call
 * scheduler keeps call-schedule.ts semantics: one retry after 5 minutes,
 * then a missed-call note and a message.
 */

describe('phone call scheduling', () => {
  let env: ReturnType<typeof tempHome>;
  let messages: string[];
  let wiring: ReturnType<typeof setupPhoneReach> | null;

  beforeEach(() => { env = tempHome(); _resetPresence(); resetToolBridge(); messages = []; wiring = null; });
  afterEach(() => { wiring?.scheduler.stop(); wiring?.stop(); registerCallScheduler('whatsapp', null); resetToolBridge(); vi.useRealTimers(); env.restore(); });

  const setup = (service = new ReachService({ phones: () => [] })) => {
    wiring = setupPhoneReach({ messageOwner: async (t) => { messages.push(t); }, service });
    return { service, scheduler: wiring.scheduler };
  };

  it('an unanswered call is retried once after 5 minutes, then leaves a note and a message', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const call = vi.spyOn(service, 'callOwner');
    const r = await service.callOwner({ reason: 'the deploy failed' });
    expect(r.text).toMatch(/try once more in 5 minutes/);
    expect(wiring!.scheduler.list()).toMatchObject([{ topic: 'the deploy failed', attempts: 1 }]);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toMatchObject({ source: 'scheduled', followUp: false });
    expect(wiring!.scheduler.list()).toEqual([]);
    expect(listMissed()).toMatchObject([{ kind: 'call', body: 'the deploy failed' }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/I tried to call you about the deploy failed/);
  });

  it('a scheduled call rings at its time, retries once, then gives up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 14, 0));
    const { service, scheduler } = setup();
    const call = vi.spyOn(service, 'callOwner');
    scheduler.schedule('in 10 minutes', 'the standup');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].reason).toBe('you asked me to call about the standup');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(call).toHaveBeenCalledTimes(2);
    expect(listMissed()).toHaveLength(1);
  });

  it('a declined or settled outcome is not retried and leaves no extra note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 14, 0));
    writeReachSettings({ calls: false });
    const { service, scheduler } = setup();
    const call = vi.spyOn(service, 'callOwner');
    scheduler.schedule('in 1 minute', 'x');
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(call).toHaveBeenCalledTimes(1);
    // The call became one notification (queued for the app), nothing else.
    expect(listMissed()).toMatchObject([{ title: 'Mercury wanted to call you' }]);
    expect(messages).toEqual([]);
  });

  it('new scheduled calls go to the phone only once a phone is paired; WhatsApp keeps its own', () => {
    const wa = new CallScheduler('whatsapp', async () => {});
    registerCallScheduler('whatsapp', wa);
    const { scheduler } = setup();
    expect(activeCallScheduler()).toBe(wa);
    createDevice('Pixel', 'android');
    expect(activeCallScheduler()).toBe(scheduler);
    expect(pluginCallScheduler()).toBe(wa);
  });

  it('falls back to WhatsApp\'s call_owner tool when it runs', async () => {
    expect(whatsappCaller()).toBeNull();
    const invoke = vi.fn(async () => 'answered: in progress');
    publishTool({ pluginId: 'whatsapp', pluginName: 'WhatsApp', name: 'call_owner', description: '', inputSchema: {}, readOnly: false, timeoutMs: 1000, invoke } as never);
    expect(await whatsappCaller()!('hello')).toBe('answered: in progress');
    expect(invoke).toHaveBeenCalledWith({ reason: 'hello' }, expect.any(AbortSignal));
  });
});

describe('call when something\'s wrong', () => {
  let env: ReturnType<typeof tempHome>;
  beforeEach(() => { env = tempHome(); });
  afterEach(() => env.restore());

  const entry = (kind: BotInboxEntry['kind']): BotInboxEntry => ({ id: 'e', botId: 'b', botName: 'Scout', runId: 'r', kind, title: 'Scout failed (timeout)', summary: 'It timed out', files: [], at: 0, read: false });
  const fake = () => {
    const s = new ReachService({ phones: () => [] });
    return { s, call: vi.spyOn(s, 'callOwner'), notify: vi.spyOn(s, 'notifyOwner') };
  };

  it('defaults: a bot that needs you sends a notification; a bot\'s own failure report does nothing', async () => {
    const { s, call, notify } = fake();
    await onBotInboxEntry(entry('needs-you'), s);
    await onBotInboxEntry(entry('failed'), s);
    await onBotInboxEntry(entry('result'), s);
    expect(call).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Scout failed (timeout)', urgency: 'high', source: 'trigger' });
  });

  it('the owner can make one ring instead', async () => {
    writeReachSettings({ triggers: { botNeedsYou: 'call' } });
    const { s, call } = fake();
    await onBotInboxEntry(entry('needs-you'), s);
    expect(call.mock.calls[0][0]).toMatchObject({ reason: 'Scout failed (timeout): It timed out', urgency: 'high', source: 'trigger' });
  });

  it('only long background tasks that failed count', async () => {
    const { s, notify } = fake();
    const task = (status: BackgroundTask['status'], ms: number): BackgroundTask => ({ id: 't', type: 'shell', command: 'npm run build', cwd: '/', status, startedAt: 0, completedAt: ms, exitCode: 1, stdout: '', stderr: 'boom', timeoutMs: 0 });
    await onBackgroundTaskDone(task('failed', 60_000), s);
    await onBackgroundTaskDone(task('completed', LONG_TASK_MS), s);
    expect(notify).not.toHaveBeenCalled();
    await onBackgroundTaskDone(task('timed_out', LONG_TASK_MS), s);
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Background task timed out: npm run build', body: 'boom' });
  });
});
