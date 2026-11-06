import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebChannel, type ChatEvent } from './web.js';

afterEach(() => vi.useRealTimers());

describe('WebChannel session cancellation', () => {
  it('denies all waits in the stopped session, rejects stale answers and preserves another session', async () => {
    vi.useFakeTimers();
    const channel = new WebChannel('Mercury');
    const events = new Map<string, ChatEvent[]>();
    for (const id of ['A', 'B']) {
      const received: ChatEvent[] = [];
      events.set(id, received);
      channel.addSSEClient({
        enqueue(value: Uint8Array) {
          const text = new TextDecoder().decode(value);
          const type = text.match(/^event: (.+)$/m)?.[1];
          const json = text.match(/^data: (.+)$/m)?.[1];
          if (type && json) received.push({ type, data: JSON.parse(json) } as ChatEvent);
        },
        close() {},
      } as unknown as ReadableStreamDefaultController, id);
    }
    const permissionA = channel.askPermission('Write A?', 'A');
    const continueA = channel.askToContinue('More A?', 'A');
    const choiceA = channel.presentChoicePrompt('Choose A', [{ value: 'go', label: 'Go' }], 'A');
    const planA = channel.askResearchPlan('plan-A', 'A', ['question A'], 'A', 1000);
    const permissionB = channel.askPermission('Write B?', 'B');
    const planB = channel.askResearchPlan('plan-B', 'B', ['question B'], 'B', 1000);
    const pendingA = channel.pendingFor('A');
    const pendingB = channel.pendingFor('B');
    expect(pendingA).toHaveLength(4);
    expect(pendingB).toHaveLength(2);

    channel.cancelInteractionsFor('A');
    expect(await permissionA).toBe('no');
    expect(await continueA).toBe(false);
    expect(await choiceA).toBe('');
    expect(await planA).toEqual({ action: 'cancel', questions: ['question A'] });
    expect(channel.pendingFor('A')).toEqual([]);
    expect(channel.pendingFor('B')).toEqual(pendingB);
    for (const event of pendingA) {
      const id = event.data!.id as string;
      expect(channel.resolveApproval(id, 'yes', 'A')).toBe(false);
      expect(channel.resolveChoice(id, 'go', 'A')).toBe(false);
      expect(channel.answerResearchPlan(id, 'start')).toBe(false);
    }
    expect(events.get('A')!.filter((e) => e.type.endsWith('_resolved'))).toHaveLength(4);
    expect(events.get('B')!.filter((e) => e.type.endsWith('_resolved'))).toEqual([]);
    channel.cancelInteractionsFor('A'); // Idempotent: nothing can be replayed.
    expect(channel.resolveApproval(pendingB[0].data!.id as string, 'yes', 'B')).toBe(true);
    expect(await permissionB).toBe('yes');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await planB).toEqual({ action: 'start', questions: ['question B'], timedOut: true });
    expect(channel.pendingFor('B')).toEqual([]);
    await channel.stop();
  });
});
