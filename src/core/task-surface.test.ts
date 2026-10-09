import { describe, expect, it, vi } from 'vitest';
import { createTaskSurface, evidenceFooter, isSubstantialTask } from './task-surface.js';

const meta = { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, totalTokens: 3, budgetUsed: 0, budgetTotal: 100, budgetPercentage: 0 };

function messagingChannel(opts: { deferResponse?: boolean } = {}) {
  const calls: string[] = [];
  const ch: any = {
    type: 'telegram',
    send: vi.fn(async (text: string) => { calls.push(`send:${text}`); }),
    stream: vi.fn(async (it: AsyncIterable<string>) => { let out = ''; for await (const c of it) out += c; calls.push(`stream:${out}`); return out; }),
    beginTask: vi.fn(() => calls.push('beginTask')),
    endTask: vi.fn(() => calls.push('endTask')),
    resetStepCounter: vi.fn(() => calls.push('resetStepCounter')),
    popDeferredResponse: vi.fn(() => undefined),
    sendCompletion: vi.fn(async () => { calls.push('sendCompletion'); }),
    cleanupEphemeralMessages: vi.fn(async () => { calls.push('cleanup'); }),
  };
  if (opts.deferResponse) ch.deferResponse = vi.fn((_id: string, text: string) => calls.push(`defer:${text}`));
  return { ch, calls };
}

describe('TaskSurface (ROADMAP P1.1 feedback contract)', () => {
  it('is a no-op for internal turns and missing channels', async () => {
    const none = createTaskSurface(undefined, 'cli', 'x');
    expect(none.kind).toBe('none');
    await none.done({ finalText: 'x', elapsedMs: 0, stepCount: 0, meta, traceId: 't', alreadyStreamed: false });
    expect(await none.fail('boom')).toBe(false);
    expect(createTaskSurface({ send: vi.fn() } as any, 'internal', 'x').kind).toBe('none');
  });

  it('messaging: begin resets and starts the task; pause ends the task BEFORE sending (persistent message)', async () => {
    const { ch, calls } = messagingChannel();
    ch.popDeferredResponse = vi.fn(() => 'streamed so far');
    const s = createTaskSurface(ch, 'telegram', 'chat1');
    s.begin();
    await s.pause('paused banner');
    expect(calls).toEqual(['resetStepCounter', 'beginTask', 'endTask', 'resetStepCounter', 'send:streamed so far', 'send:paused banner']);
  });

  it('messaging: fail ends the task first and delivers the reason', async () => {
    const { ch, calls } = messagingChannel();
    const s = createTaskSurface(ch, 'discord', 'c');
    expect(await s.fail('All providers failed')).toBe(true);
    expect(calls.slice(0, 2)).toEqual(['endTask', 'resetStepCounter']);
    expect(calls.at(-1)).toBe('send:All providers failed');
  });

  it('messaging: short turns send the text (deferred wins) and clean up; evidence rides in the text', async () => {
    const { ch, calls } = messagingChannel();
    const s = createTaskSurface(ch, 'slack', 'c');
    await s.done({ finalText: 'answer', elapsedMs: 1000, stepCount: 1, meta, verificationNote: 'npm test ✓', traceId: 'abc123', alreadyStreamed: false });
    expect(calls).toEqual(['endTask', 'send:answer\n\n_Verification: npm test ✓ · /trace abc123_', 'cleanup', 'resetStepCounter']);
  });

  it('messaging: substantial turns defer (Telegram) or stream (others) then send the completion banner', async () => {
    const tg = messagingChannel({ deferResponse: true });
    await createTaskSurface(tg.ch, 'telegram', 'c').done({ finalText: 'big', elapsedMs: 60_000, stepCount: 5, meta, traceId: 't1', alreadyStreamed: false });
    expect(tg.calls).toEqual(['defer:big', 'sendCompletion']);

    const sg = messagingChannel();
    await createTaskSurface(sg.ch, 'signal', 'c').done({ finalText: 'big', elapsedMs: 60_000, stepCount: 5, meta, traceId: 't1', alreadyStreamed: false });
    expect(sg.calls).toEqual(['stream:big', 'sendCompletion']);
  });

  it('cli: sends unless already streamed; banner on substantial or forced turns carries verification + trace', async () => {
    const cli: any = { type: 'cli', send: vi.fn(async () => {}), sendCompletion: vi.fn() };
    const s = createTaskSurface(cli, 'cli', 'current');
    await s.done({ finalText: 'streamed', elapsedMs: 100, stepCount: 0, meta, traceId: 't2', alreadyStreamed: true });
    expect(cli.send).not.toHaveBeenCalled();
    expect(cli.sendCompletion).not.toHaveBeenCalled();
    await s.done({ finalText: 'x', elapsedMs: 100, stepCount: 0, meta, verificationNote: 'tsc ✓', traceId: 't2', alreadyStreamed: false, forceBanner: true });
    expect(cli.send).toHaveBeenCalledWith('x', 'current', 100);
    expect(cli.sendCompletion).toHaveBeenCalledWith(100, 0, meta, undefined, 'tsc ✓ · /trace t2');
  });

  it('web: failures go through sendError and report delivery', async () => {
    const web: any = { type: 'web', send: vi.fn(async () => {}), sendError: vi.fn(() => false) };
    expect(await createTaskSurface(web, 'web', 'conv').fail('nope')).toBe(false);
    expect(web.sendError).toHaveBeenCalledWith('nope', 'conv');
  });

  it('helpers', () => {
    expect(isSubstantialTask(3, 30_000)).toBe(true);
    expect(isSubstantialTask(2, 30_000)).toBe(false);
    expect(evidenceFooter(undefined, 'id')).toBe('_/trace id_');
  });
});
