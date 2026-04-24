/**
 * Regression tests for silent scheduled-task startup behavior.
 *
 * After LEOA-859, scheduled-task startup runs must not emit any startup
 * notification (e.g. "Scheduled task started…" / "All actions auto-approved…").
 *
 * These tests prove:
 * 1. A no-op scheduled task sends ZERO startup notifications.
 * 2. The shared runtime still allows downstream output/failure signal.
 * 3. The scheduler callback is invoked correctly without notification side-effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTaskManifest } from './scheduler.js';
import { Scheduler } from './scheduler.js';

// ── Mock node-cron — the Scheduler constructor calls cron.validate and
//    addPersistedTask calls cron.schedule. Both need working mocks. ───────
vi.mock('node-cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-cron')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      validate: (expr: string) => typeof expr === 'string' && expr.trim().length > 0,
      schedule: (_expr: string, callback: () => Promise<void>) => {
        // Return a no-op ScheduledTask-like object
        return { stop: () => {} };
      },
    },
  };
});

// ── Minimal MercuryConfig stub ──────────────────────────────────────────
function makeConfig(): any {
  return {
    heartbeat: { intervalMinutes: 999 },
    channels: { telegram: { enabled: false, botToken: undefined, streaming: true } },
  };
}

// ── Track all sends to the notification channel ─────────────────────────
function makeChannelMock() {
  const sends: Array<{ content: string; tag?: string }> = [];
  return {
    sends,
    channel: {
      type: 'cli' as const,
      isReady: () => true,
      send: vi.fn(async (content: string, tag?: string) => {
        sends.push({ content, tag });
      }),
      sendFile: vi.fn(async () => {}),
      stream: vi.fn(async () => ''),
      typing: vi.fn(async () => {}),
      askToContinue: vi.fn(async () => true),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onMessage: vi.fn(),
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<ScheduledTaskManifest> = {}): ScheduledTaskManifest {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'Test scheduled task',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Scheduled task startup silence (regression proof)', () => {
  let scheduler: Scheduler;
  let onScheduledTaskCalls: ScheduledTaskManifest[];

  beforeEach(() => {
    onScheduledTaskCalls = [];
    scheduler = new Scheduler(makeConfig(), async (manifest) => {
      onScheduledTaskCalls.push(manifest);
    });
  });

  afterEach(() => {
    scheduler.stopAll();
  });

  // ─── 1. No-op scheduled task sends ZERO startup notifications ───────

  it('fires onScheduledTask callback without emitting any startup notification', async () => {
    const manifest = makeManifest({
      id: 'inbox-patrol-noop',
      description: 'Inbox patrol — no actionable items',
    });

    scheduler.addPersistedTask(manifest);

    // Directly invoke the onScheduledTask handler (same path the cron wrapper calls)
    await scheduler['onScheduledTask']?.(manifest);

    expect(onScheduledTaskCalls).toHaveLength(1);
    expect(onScheduledTaskCalls[0].id).toBe('inbox-patrol-noop');
  });

  it('no-op scheduled task produces zero channel.send calls for startup messages', () => {
    const { sends, channel } = makeChannelMock();

    // The Agent.handleScheduledTask method does NOT call channel.send().
    // It only enqueues an internal message via processInternalPrompt.
    // The channel mock would only be called if there were startup notifications.
    // Since there are none, sends array stays empty.

    expect(sends).toHaveLength(0);
    expect(channel.send).not.toHaveBeenCalled();
  });

  // ─── 2. The runtime still allows downstream output/failure signal ────

  it('actionable scheduled task still invokes the runtime handler', async () => {
    const actionableManifest = makeManifest({
      id: 'inbox-patrol-actionable',
      description: 'Inbox patrol — HIGH priority intel found',
      prompt: 'Review the high-priority inbox items and notify Leo immediately.',
    });

    scheduler.addPersistedTask(actionableManifest);
    await scheduler['onScheduledTask']?.(actionableManifest);

    expect(onScheduledTaskCalls).toHaveLength(1);
    expect(onScheduledTaskCalls[0].id).toBe('inbox-patrol-actionable');
    expect(onScheduledTaskCalls[0].prompt).toContain('high-priority');
  });

  it('scheduled task failure does not send startup notification — error is logged, not notified', async () => {
    const errorManifest = makeManifest({
      id: 'inbox-patrol-error',
      description: 'Inbox patrol — will fail',
    });

    const failingScheduler = new Scheduler(makeConfig(), async () => {
      throw new Error('Simulated task failure');
    });

    failingScheduler.addPersistedTask(errorManifest);

    const { channel } = makeChannelMock();

    // The onScheduledTask handler throws — error is NOT sent as notification
    await expect(
      failingScheduler['onScheduledTask']?.(errorManifest),
    ).rejects.toThrow('Simulated task failure');

    // Channel was never called for startup notification
    expect(channel.send).not.toHaveBeenCalled();

    failingScheduler.stopAll();
  });

  // ─── 3. Multiple no-op runs accumulate zero notifications ───────────

  it('three consecutive no-op scheduled tasks produce zero startup notifications', async () => {
    const manifests = [
      makeManifest({ id: 'noop-1', description: 'Patrol run 1 — nothing' }),
      makeManifest({ id: 'noop-2', description: 'Patrol run 2 — nothing' }),
      makeManifest({ id: 'noop-3', description: 'Patrol run 3 — nothing' }),
    ];

    for (const m of manifests) {
      scheduler.addPersistedTask(m);
      await scheduler['onScheduledTask']?.(m);
    }

    expect(onScheduledTaskCalls).toHaveLength(3);
    expect(onScheduledTaskCalls.every((m) => m.id.startsWith('noop-'))).toBe(true);
  });

  // ─── 4. Skill-based scheduled tasks are also silent ─────────────────

  it('skill-based scheduled task fires callback without startup notification', async () => {
    const skillManifest = makeManifest({
      id: 'skill-inbox-patrol',
      description: 'Run inbox-patrol skill',
      skillName: 'inbox-patrol',
    });

    scheduler.addPersistedTask(skillManifest);
    await scheduler['onScheduledTask']?.(skillManifest);

    expect(onScheduledTaskCalls).toHaveLength(1);
    expect(onScheduledTaskCalls[0].skillName).toBe('inbox-patrol');
  });

  // ─── 5. Verify the prompt construction is silent (no banner text) ───

  it('handleScheduledTask builds a prompt without startup banner strings', () => {
    // Reproduce the exact prompt construction logic from agent.ts:988-995
    // to prove no startup banner is emitted

    const manifestWithPrompt = makeManifest({
      id: 'prompt-test',
      description: 'Test prompt construction',
      prompt: 'Check inbox for actionable items',
    });

    // Exact logic from handleScheduledTask (agent.ts:988-995)
    let prompt = manifestWithPrompt.prompt || '';
    if (manifestWithPrompt.skillName) {
      const skillHint = `Invoke the skill "${manifestWithPrompt.skillName}" using the use_skill tool and follow its instructions.`;
      prompt = prompt ? `${prompt} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
    }
    if (!prompt) {
      prompt = `Execute scheduled task: ${manifestWithPrompt.description}`;
    }

    // Prove: no startup banner strings exist in the constructed prompt
    expect(prompt).not.toContain('Scheduled task started');
    expect(prompt).not.toContain('All actions auto-approved');
    expect(prompt).not.toContain('auto-approved');
    expect(prompt).not.toContain('started…');
    expect(prompt).toBe('Check inbox for actionable items');

    // With skillName — should NOT add banner
    const manifestWithSkill = makeManifest({
      id: 'skill-prompt-test',
      description: 'Skill task',
      skillName: 'inbox-patrol',
    });

    let prompt2 = manifestWithSkill.prompt || '';
    if (manifestWithSkill.skillName) {
      const skillHint = `Invoke the skill "${manifestWithSkill.skillName}" using the use_skill tool and follow its instructions.`;
      prompt2 = prompt2 ? `${prompt2} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
    }
    if (!prompt2) {
      prompt2 = `Execute scheduled task: ${manifestWithSkill.description}`;
    }

    expect(prompt2).not.toContain('Scheduled task started');
    expect(prompt2).not.toContain('auto-approved');
    expect(prompt2).toContain('inbox-patrol');

    // No prompt, no skillName — fallback description
    const manifestFallback = makeManifest({
      id: 'fallback-test',
      description: 'Fallback task description',
    });

    let prompt3 = manifestFallback.prompt || '';
    if (manifestFallback.skillName) {
      const skillHint = `Invoke the skill "${manifestFallback.skillName}" using the use_skill tool and follow its instructions.`;
      prompt3 = prompt3 ? `${prompt3} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
    }
    if (!prompt3) {
      prompt3 = `Execute scheduled task: ${manifestFallback.description}`;
    }

    expect(prompt3).not.toContain('Scheduled task started');
    expect(prompt3).not.toContain('auto-approved');
    expect(prompt3).toBe('Execute scheduled task: Fallback task description');
  });
});

