import { describe, expect, it, vi } from 'vitest';
import { WebChannel } from './web.js';

describe('web channel reasoning stream', () => {
  it('batches deltas and closes the block when the answer starts', async () => {
    vi.useFakeTimers();
    const ch = new WebChannel('Mercury');
    const sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
    (ch as unknown as { broadcast: (e: { type: string; data?: Record<string, unknown> }) => boolean }).broadcast = (e) => { sent.push(e); return true; };
    ch.sendReasoning('Let me ', 's1');
    ch.sendReasoning('check the file.', 's1');
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(130);
    expect(sent).toEqual([{ type: 'reasoning', data: { text: 'Let me check the file.', targetId: 's1' } }]);
    ch.sendReasoning(' Then edit it.', 's1');
    ch.sendReasoning(null, 's1');
    expect(sent.slice(1)).toEqual([
      { type: 'reasoning', data: { text: ' Then edit it.', targetId: 's1' } },
      { type: 'reasoning', data: { done: true, targetId: 's1' } },
    ]);
    vi.useRealTimers();
  });
});
