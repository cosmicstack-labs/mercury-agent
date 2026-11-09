import { afterAll, describe, expect, it, vi } from 'vitest';
// Import the harness before production modules to establish its scratch home.
import { EvalHarness } from '../runner.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadSchedules } from '../../core/scheduler.js';
import { WorkLedger } from '../../core/work-ledger.js';
import { call, textStep, toolStep } from '../fixture.js';

afterAll(async () => (await import('../env.js')).removeEvalRoot());

async function settleUntil(done: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error('Scheduled agent turn did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(0);
  }
}

describe.each([false, true])('eval · scheduled real work (streaming=%s)', (streaming) => {
  it.each([false, true])('persists the actual agent outcome and never replays the one-shot (provider fails=%s)', async (fails) => {
    const harness = await EvalHarness.create({
      name: `scheduled-real-work-${streaming}-${fails}`,
      channel: { streaming },
      providers: [{ name: 'primary' }, { name: 'backup' }],
      turns: [],
    });
    const target = join(harness.workDir, 'scheduled-receipt.txt');
    const observedAfterWrite: Array<{ status: string | undefined; content: string }> = [];
    const scheduler = harness.agent.scheduler;
    try {
      harness.player.load({
        message: 'Create scheduled-receipt.txt containing accepted.',
        steps: [toolStep([call('create_file', { path: 'scheduled-receipt.txt', content: 'accepted' })])],
        onExhausted: () => {
          // This is the next real SDK model call, after the real filesystem
          // tool has returned. Enqueueing alone must not complete the run.
          observedAfterWrite.push({ status: loadSchedules()[0]?.lastRun?.status, content: readFileSync(target, 'utf8') });
          if (fails) throw new Error('Provider connection lost after scheduled write');
          return textStep('Created scheduled-receipt.txt with accepted.');
        },
      });
      scheduler.addDelayedTask({
        id: 'scheduled-receipt',
        description: 'Write a receipt once',
        prompt: 'Create scheduled-receipt.txt containing accepted.',
        delaySeconds: 1,
        // Due now, so only zero-delay fake timers need to run. No heartbeat,
        // watchdog, or guessed sleep participates in the test.
        executeAt: new Date(Date.now() - 1).toISOString(),
        createdAt: new Date().toISOString(),
        missedRunPolicy: 'run_once',
        sourceChannelId: harness.channelId,
        sourceChannelType: harness.channelType,
      });
      scheduler.persistSchedules();
      vi.advanceTimersByTime(0);
      await settleUntil(() => {
        const status = scheduler.getManifest('scheduled-receipt')?.lastRun?.status;
        return status === 'completed' || status === 'failed';
      });

      expect(observedAfterWrite).toEqual([{ status: 'running', content: 'accepted' }]);
      expect(harness.capabilities.toolLog).toHaveLength(1);
      expect(harness.capabilities.toolLog[0]).toMatchObject({ tool: 'create_file', recorded: false });
      expect(harness.player.calls).toHaveLength(2);
      expect(harness.providers[1].callCount).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe('accepted');

      const saved = loadSchedules()[0];
      expect(saved.lastRun?.status).toBe(fails ? 'failed' : 'completed');
      expect(saved.lastRun?.finishedAt).toBeTruthy();
      if (fails) {
        expect(saved.paused).toBe(true);
        expect(saved.lastRun?.error).toContain('interrupted/ambiguous');
        expect(harness.channel.events.some((event) => event.text.includes('interrupted/ambiguous'))).toBe(true);
        expect(harness.channel.events.some((event) => event.text.includes('Task complete'))).toBe(false);
      } else {
        expect(harness.channel.events.some((event) => event.kind === 'delivered' && event.text.includes('Created scheduled-receipt.txt'))).toBe(true);
      }

      const workKey = `channel:${harness.channelType}:scheduled-${saved.lastRun!.id}`;
      const reloadedLedger = new WorkLedger();
      expect(reloadedLedger.get(workKey)).toMatchObject({
        status: fails ? 'failed' : 'completed',
        attempts: 1,
        message: { metadata: { scheduledTaskId: saved.id, scheduledRunId: saved.lastRun!.id } },
      });
      expect(reloadedLedger.get(workKey)?.nextAttemptAt).toBeUndefined();
      // In particular, the ordinary chat interrupted-work recovery path must
      // not enqueue a failed scheduled turn for a second side effect.
      expect(reloadedLedger.recoverInterrupted()).toEqual([]);

      writeFileSync(target, 'later owner edit');
      scheduler.stopAll();
      scheduler.restorePersistedTasks();
      // This passes every ordinary short retry delay without a live heartbeat.
      // It also catches a restored overdue run_once timer being armed again.
      vi.advanceTimersByTime(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scheduler.getManifest(saved.id)?.lastRun).toEqual(saved.lastRun);
      expect(harness.player.calls).toHaveLength(2);
      expect(harness.capabilities.toolLog).toHaveLength(1);
      expect(readFileSync(target, 'utf8')).toBe('later owner edit');
    } finally {
      await harness.dispose();
    }
  });
});
