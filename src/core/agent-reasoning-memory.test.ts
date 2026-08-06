import { describe, expect, it } from 'vitest';
import { toModelMessages } from './agent.js';

describe('assistant reasoning is preserved in replayed short-term memory', () => {
  it('replays assistant reasoning alongside assistant text when available', () => {
    const messages = toModelMessages([
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'world', reasoning: 'think-step', timestamp: 2 },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think-step' },
          { type: 'text', text: 'world' },
        ],
      },
    ]);
  });

  it('keeps assistant messages as plain text when no reasoning exists', () => {
    const messages = toModelMessages([
      { id: 'assistant-1', role: 'assistant', content: 'plain reply', timestamp: 1 },
    ]);

    expect(messages).toEqual([
      { role: 'assistant', content: 'plain reply' },
    ]);
  });
});
