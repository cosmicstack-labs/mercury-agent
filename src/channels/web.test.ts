import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebChannel } from './web.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('WebChannel durable streaming', () => {
  it('preserves repeated delta chunks verbatim', async () => {
    const channel = new WebChannel('Mercury');
    const chunks: string[] = [];
    channel.addSSEClient({
      enqueue(value: Uint8Array) {
        chunks.push(new TextDecoder().decode(value));
      },
      close() {},
    } as unknown as ReadableStreamDefaultController, 'request-1');

    const result = await channel.stream((async function* () {
      yield 'ha';
      yield 'ha';
      yield '!!';
      yield '!!';
    })(), 'request-1');

    expect(result).toBe('haha!!!!');
    expect(chunks.join('')).toContain('data: {"text":"ha","targetId":"request-1"}');
    expect(chunks.filter((chunk) => chunk.includes('"text":"ha"'))).toHaveLength(2);
    expect(chunks.filter((chunk) => chunk.includes('"text":"!!"'))).toHaveLength(2);
  });

  it('retains a cloud terminal handler when the socket cannot accept delivery', async () => {
    const channel = new WebChannel('Mercury');
    const handler = vi.fn(() => false);
    channel.emitCloudMessage('work', 'request-2', 'session-2', 'conversation-2', undefined, handler);

    await expect(channel.send('final answer', 'request-2')).rejects.toThrow('could not accept');
    expect(channel.hasCloudEventHandler('request-2')).toBe(true);
  });

  it('keeps a cloud request attached after a non-terminal provider status', () => {
    const channel = new WebChannel('Mercury');
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    channel.emitCloudMessage('work', 'request-fallback', 'session-2', 'conversation-2', undefined, (event) => {
      events.push(event);
      return true;
    });

    channel.sendHeartbeat('A model attempt failed. Trying another option...', 'request-fallback');

    expect(events).toContainEqual(expect.objectContaining({ type: 'heartbeat' }));
    expect(channel.hasCloudEventHandler('request-fallback')).toBe(true);
  });

  it('keeps provider diagnostics out of terminal errors', () => {
    const channel = new WebChannel('Mercury');
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    channel.emitCloudMessage('work', 'request-error', 'session-2', 'conversation-2', undefined, (event) => {
      events.push(event);
      return true;
    });

    channel.sendError('OpenRouter error 401: invalid API key sk-secret', 'request-error');

    expect(events[0]?.data?.message).toContain('Mercury could not connect');
    expect(JSON.stringify(events)).not.toMatch(/openrouter|sk-secret/i);
  });

  it('requires an explicit continuation decision even when permissions are bypassed', async () => {
    vi.useFakeTimers();
    const channel = new WebChannel('Mercury');
    channel.setBypassPermissions(true);
    const chunks: string[] = [];
    channel.addSSEClient({
      enqueue(value: Uint8Array) {
        chunks.push(new TextDecoder().decode(value));
      },
      close() {},
    } as unknown as ReadableStreamDefaultController, 'request-3');

    const decision = channel.askToContinue('Continue?', 'request-3');
    const event = chunks.join('').match(/"id":"([^"]+)"/);
    expect(event?.[1]).toBeTruthy();
    expect(channel.resolveApproval(event![1], 'no')).toBe(true);
    await expect(decision).resolves.toBe(false);
  });

  it('binds Cloud approvals to one request and rejects invalid values and replay', async () => {
    vi.useFakeTimers();
    const channel = new WebChannel('Mercury');
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    channel.emitCloudMessage('work', 'request-bound', 'session-1', 'conversation-1', undefined, (event) => {
      events.push(event);
      return true;
    });

    const decision = channel.askPermission('Write file?', 'request-bound');
    const id = events.find((event) => event.type === 'permission_request')?.data?.id as string;

    expect(channel.resolveApproval(id, 'yes', 'different-request')).toBe(false);
    expect(channel.resolveApproval(id, 'unexpected', 'request-bound')).toBe(false);
    expect(channel.resolveApproval(id, 'yes', 'request-bound')).toBe(true);
    expect(channel.resolveApproval(id, 'no', 'request-bound')).toBe(false);
    await expect(decision).resolves.toBe('yes');
  });

  it('cancels an unanswered choice instead of selecting the first option', async () => {
    vi.useFakeTimers();
    const channel = new WebChannel('Mercury');
    const decision = channel.presentChoicePrompt('Choose', [
      { value: 'dangerous', label: 'Proceed' },
      { value: 'safe', label: 'Cancel' },
    ]);

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(decision).resolves.toBe('');
  });

  it('supports an explicit one-shot cancellation for a bound Cloud choice', async () => {
    const channel = new WebChannel('Mercury');
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    channel.emitCloudMessage('work', 'request-choice', 'session-1', 'conversation-1', undefined, (event) => {
      events.push(event);
      return true;
    });
    const decision = channel.presentChoicePrompt('Choose', [{ value: 'continue', label: 'Continue' }], 'request-choice');
    const id = events.find((event) => event.type === 'choice_prompt')?.data?.id as string;

    expect(channel.cancelInteraction(id, 'wrong-request')).toBe(false);
    expect(channel.cancelInteraction(id, 'request-choice')).toBe(true);
    expect(channel.cancelInteraction(id, 'request-choice')).toBe(false);
    await expect(decision).resolves.toBe('');
  });

  it('scopes allow-all mode to its Cloud session', async () => {
    const channel = new WebChannel('Mercury');
    channel.setSessionPermissionMode('session-allowed', 'allow-all');
    channel.emitCloudMessage('work', 'request-allowed', 'session-allowed', 'conversation-1', undefined, () => true);

    await expect(channel.askPermission('Write file?', 'request-allowed')).resolves.toBe('yes');
  });
});
