import { afterAll, describe, expect, it } from 'vitest';
// Bootstrap the isolated Mercury home before importing production modules.
import { EvalHarness } from '../runner.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkLedger } from '../../core/work-ledger.js';
import { call, textStep, toolStep } from '../fixture.js';

afterAll(async () => (await import('../env.js')).removeEvalRoot());

/** Wait for an observable model boundary, never a guessed delay or fake time. */
async function waitForModelCalls(harness: EvalHarness, count: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (harness.player.calls.length < count) {
    if (performance.now() > deadline) throw new Error(`Expected ${count} model calls, saw ${harness.player.calls.length}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe.each([false, true])('eval · real-work reliability (streaming=%s)', (streaming) => {
  it('preserves a denied file, sends the denial back to the model, and requires a fresh approval', async () => {
    const harness = await EvalHarness.create({
      name: `denied-write-${streaming}`, channel: { streaming }, autoApprove: false, turns: [],
    });
    const target = join(harness.workDir, 'note.txt');
    writeFileSync(target, 'original');
    const approvals: string[] = [];
    harness.capabilities.permissions.onAsk(async (prompt) => { approvals.push(prompt); return 'no'; });
    try {
      const denied = await harness.runTurn({
        message: 'Replace the contents of note.txt with revised.',
        steps: [
          toolStep([call('write_file', { path: 'note.txt', content: 'revised' })]),
          // A model repeating the same action must not turn a denial into approval.
          toolStep([call('write_file', { path: 'note.txt', content: 'revised' })]),
          textStep('The write was denied. note.txt is unchanged.'),
        ],
        expect: { providerCalls: 3, finalTextIncludes: ['denied', 'unchanged'], noEventIncludes: ['Task complete'] },
      });
      expect(denied.failures).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe('original');
      expect(approvals).toHaveLength(2);
      expect(approvals.every((prompt) => prompt.includes(target))).toBe(true);
      expect(denied.toolCalls).toHaveLength(2);
      for (const invocation of denied.toolCalls) {
        expect(invocation.recorded).toBe(false);
        expect(invocation.output).toContain('Permission denied');
      }
      expect(harness.promptOf(1)).toContain('Permission denied');
      expect(harness.promptOf(2)).toContain('Permission denied');
      expect(denied.sessionEntries.some((entry) => entry.kind === 'tool-call' && entry.content.includes('Permission denied'))).toBe(true);

      harness.capabilities.permissions.onAsk(async (prompt) => { approvals.push(prompt); return 'yes'; });
      const approved = await harness.runTurn({
        message: 'Try writing revised to note.txt again; I will approve this time.',
        steps: [toolStep([call('write_file', { path: 'note.txt', content: 'revised' })]), textStep('Updated note.txt.')],
        expect: { providerCalls: 2, deliveredCount: 1 },
      });
      expect(approved.failures).toEqual([]);
      expect(approvals).toHaveLength(3);
      expect(readFileSync(target, 'utf8')).toBe('revised');
      expect(approved.toolCalls[0]).toMatchObject({ recorded: false, tool: 'write_file' });
    } finally {
      await harness.dispose();
    }
  });

  it('does not rerun tools or overwrite later edits when a completed transport message is redelivered', async () => {
    const harness = await EvalHarness.create({ name: `duplicate-completed-${streaming}`, channel: { streaming }, turns: [] });
    const target = join(harness.workDir, 'receipt.txt');
    const messageId = 'same-transport-message';
    try {
      const first = await harness.runTurn({
        messageId, message: 'Write receipt.txt with the text accepted.',
        steps: [toolStep([call('create_file', { path: 'receipt.txt', content: 'accepted' })]), textStep('Created receipt.txt.')],
        expect: { providerCalls: 2, deliveredCount: 1 },
      });
      expect(first.failures).toEqual([]);
      expect(first.toolCalls).toHaveLength(1);
      expect(first.toolCalls[0].recorded).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('accepted');
      writeFileSync(target, 'subsequent owner edit');

      const duplicate = await harness.runTurn({
        messageId, message: 'Write receipt.txt with the text accepted.',
        expect: { providerCalls: 0, toolsUsed: [], finalTextIncludes: ['already completed'] },
      });
      expect(duplicate.failures).toEqual([]);
      expect(duplicate.sessionEntries).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe('subsequent owner edit');
      expect(new WorkLedger().get(`channel:telegram:${messageId}`)).toMatchObject({ status: 'completed', attempts: 1, delivered: true });
    } finally {
      await harness.dispose();
    }
  });

  it('suppresses provider fallback after a real side effect and preserves the pending continuation honestly', async () => {
    const harness = await EvalHarness.create({
      name: `interrupted-write-${streaming}`, channel: { streaming },
      providers: [{ name: 'primary', failOnCalls: [2], failWith: 'connection lost after write' }, { name: 'backup' }], turns: [],
    });
    const messageId = 'interrupted-after-write';
    try {
      const result = await harness.runTurn({
        messageId, message: 'Create receipt.txt with accepted and report the result.',
        steps: [toolStep([call('create_file', { path: 'receipt.txt', content: 'accepted' })])],
        expect: { providerCalls: 2, noEventIncludes: ['Task complete', 'switching to `backup`'] },
      });
      expect(result.failures).toEqual([]);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].recorded).toBe(false);
      expect(readFileSync(join(harness.workDir, 'receipt.txt'), 'utf8')).toBe('accepted');
      expect(harness.providers[1].callCount).toBe(0);
      expect(result.providerCalls[1].error).toBe('connection lost after write');
      expect(result.events.some((event) => event.text.includes('checkpointed'))).toBe(true);
      expect(result.sessionEntries.some((entry) => entry.role === 'assistant' && entry.kind === 'message')).toBe(false);
      // Ordinary chat has a durable inspected-continuation policy. This test
      // does not advance its timer or claim generic work is never retried.
      const saved = new WorkLedger().get(`channel:telegram:${messageId}`);
      expect(saved).toMatchObject({ status: 'queued', attempts: 1, message: { metadata: { workContinuation: true } } });
      expect(saved?.nextAttemptAt).toBeGreaterThan(Date.now());
    } finally {
      await harness.dispose();
    }
  });

  it('deduplicates running work and keeps an owner-stopped turn cancelled after reload', async () => {
    const harness = await EvalHarness.create({
      name: `stop-in-flight-${streaming}`, channel: { streaming },
      providers: [{ name: 'primary', waitForAbortOnCalls: [2] }, { name: 'backup' }], turns: [],
    });
    const messageId = 'stop-after-write';
    const message = 'Create receipt.txt with accepted, then report the result.';
    let pending: ReturnType<EvalHarness['runTurn']> | undefined;
    try {
      pending = harness.runTurn({
        messageId, message,
        steps: [toolStep([call('create_file', { path: 'receipt.txt', content: 'accepted' })])],
        expect: { providerCalls: 2, finalTextIncludes: ['Task stopped'], noEventIncludes: ['Task complete'] },
      });
      await waitForModelCalls(harness, 2);
      expect(existsSync(join(harness.workDir, 'receipt.txt'))).toBe(true);
      harness.channel.inject({
        id: messageId, content: message, channelId: harness.channelId, channelType: harness.channelType,
        senderId: 'eval-user', timestamp: Date.now(),
      });
      expect(harness.agent.queuedCount).toBe(0);
      expect(harness.agent.stopWorkFor(harness.channelId, 'Owner stopped this task.')).toBe(true);
      const result = await pending;
      pending = undefined;
      expect(result.failures).toEqual([]);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].recorded).toBe(false);
      expect(result.events.some((event) => event.text.includes('already running'))).toBe(true);
      expect(harness.providers[1].callCount).toBe(0);
      expect(readFileSync(join(harness.workDir, 'receipt.txt'), 'utf8')).toBe('accepted');
      const reloaded = new WorkLedger();
      expect(reloaded.get(`channel:telegram:${messageId}`)).toMatchObject({ status: 'cancelled', attempts: 1 });
      expect(reloaded.recoverInterrupted()).toEqual([]);

      const redelivery = await harness.runTurn({ messageId, message, expect: { providerCalls: 0, toolsUsed: [], finalTextIncludes: ['cancelled earlier'] } });
      expect(redelivery.failures).toEqual([]);
    } finally {
      harness.agent.stopWorkFor(harness.channelId);
      if (pending) await pending;
      await harness.dispose();
    }
  });
});
