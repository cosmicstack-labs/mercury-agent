import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WorkLedger } from './work-ledger.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(repo, p), 'utf8');

/**
 * Completion-contract integration guards: a task that did not finish must
 * never wear a "Task complete" banner or a success status. Regression class:
 * step-budget exhaustion, stalls, and unverified mutations were all reported
 * as completed.
 */
describe('completion contract — work ledger', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('markPaused records an honest, resumable pause (never completed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'mercury-work-ledger-'));
    const ledger = new WorkLedger({ filePath: join(dir, 'ledger.json') });
    const accepted = ledger.accept({
      id: 'm1', channelId: 'c1', channelType: 'cli', senderId: 'u1',
      content: 'build the dashboard', timestamp: 1,
    } as any);
    expect(accepted.accepted).toBe(true);
    ledger.markRunning(accepted.entry.key);
    const paused = ledger.markPaused(accepted.entry.key, 'Step budget reached with work pending');
    expect(paused.status).toBe('paused');
    expect(paused.status).not.toBe('completed');
    expect(paused.finalResponse).toContain('pending');

    // The pause surfaces as an undelivered response (resume hint).
    const undelivered = ledger.getUndeliveredResponses();
    expect(undelivered.some((e) => e.key === accepted.entry.key)).toBe(true);

    // Recovery resumes paused work after a restart.
    const recovered = ledger.recoverInterrupted();
    expect(recovered.some((e) => e.key === accepted.entry.key && e.status === 'queued')).toBe(true);
    expect(recovered[0].message.metadata?.workRecovered).toBe(true);
  });

  it('paused entries are not pruned as terminal', () => {
    dir = mkdtempSync(join(tmpdir(), 'mercury-work-ledger-'));
    const ledger = new WorkLedger({ filePath: join(dir, 'ledger.json'), maxTerminalEntries: 1, now: () => 1000 });
    const a = ledger.accept({ id: 'a', channelId: 'c', channelType: 'cli', senderId: 'u', content: 'task a', timestamp: 1 } as any);
    const b = ledger.accept({ id: 'b', channelId: 'c', channelType: 'cli', senderId: 'u', content: 'task b', timestamp: 2 } as any);
    ledger.markFailed(b.entry.key, 'boom');
    ledger.markPaused(a.entry.key, 'paused reason');
    // Prune runs on persist; paused must survive as resumable state.
    expect(ledger.get(a.entry.key)).toBeDefined();
    expect(ledger.get(b.entry.key)).toBeDefined();
  });
});

describe('completion contract — source guarantees', () => {
  it('sub-agent reports paused, not completed, on step-budget exhaustion', () => {
    const source = src('src/core/sub-agent.ts');
    expect(source).toContain("finishReason === 'tool-calls'");
    expect(source).toContain("status: 'paused'");
    // The guard must sit BEFORE the unconditional completed block.
    const pausedIdx = source.indexOf('Sub-agent paused at step budget');
    const completedIdx = source.indexOf("this.status = 'completed';");
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(-1);
    expect(pausedIdx).toBeLessThan(completedIdx);
  });

  it('supervisor auto-resumes a step-budget pause with a bound', () => {
    const source = src('src/core/supervisor.ts');
    expect(source).toContain('MAX_SUBAGENT_STEP_RESUMES');
    expect(source).toContain("result.status === 'paused'");
  });

  it('main loop: step-budget exhaustion pauses instead of completing', () => {
    const agent = src('src/core/agent.ts');
    expect(agent).toContain("classifyTurnEnd");
    expect(agent).toContain("stepsExhaustedPrompt");
    expect(agent).toContain("markPaused");
    // The pause verdict must short-circuit BEFORE the completion delivery —
    // the markPaused return path precedes the first sendCompletion call.
    const pauseIdx = agent.indexOf("turnEnd() === 'steps-exhausted'");
    const deliverIdx = agent.indexOf('sendCompletion(elapsed, stepCount');
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(pauseIdx);
  });

  it('CLI banner never labels a paused or change-free task complete', () => {
    const cli = src('src/channels/cli.ts');
    expect(cli).toContain('STEPS_PAUSED_BANNER');
    expect(cli).toContain('NO_CHANGES_BANNER');
    // The no-changes rewrite guards the literal banner.
    expect(cli).toContain("content.startsWith('Task complete')");
  });

  it('narration-guard exhaustion pauses instead of completing', () => {
    const agent = src('src/core/agent.ts');
    // The exhaustion verdict must re-check the guard AFTER the continuation
    // loop and pause (markPaused) before any completion delivery.
    expect(agent).toContain('WORK_NOT_STARTED_BANNER');
    expect(agent).toContain('Narration guard exhausted (both cycles)');
    const guardExhaustedIdx = agent.indexOf('Narration guard exhausted (both cycles)');
    const deliverIdx = agent.indexOf('sendCompletion(elapsed, stepCount');
    expect(guardExhaustedIdx).toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(guardExhaustedIdx);
  });
});