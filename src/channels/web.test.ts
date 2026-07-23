import { describe, expect, it, vi } from 'vitest';
import { WebChannel } from './web.js';

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
});
