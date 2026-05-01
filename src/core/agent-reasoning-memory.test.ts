import { describe, expect, it } from 'vitest';

type MemoryEntry = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
};

function toModelMessages(recentMemory: MemoryEntry[]) {
  const messages: any[] = [];

  if (recentMemory.length > 0) {
    for (const m of recentMemory) {
      if (m.role === 'assistant' && m.reasoning) {
        messages.push({
          role: 'assistant',
          content: [
            { type: 'reasoning', text: m.reasoning },
            { type: 'text', text: m.content },
          ],
        });
        continue;
      }

      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      });
    }
  }

  return messages;
}

describe('assistant reasoning is preserved in replayed short-term memory', () => {
  it('replays assistant reasoning alongside assistant text when available', () => {
    const messages = toModelMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world', reasoning: 'think-step' },
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
      { role: 'assistant', content: 'plain reply' },
    ]);

    expect(messages).toEqual([
      { role: 'assistant', content: 'plain reply' },
    ]);
  });
});
