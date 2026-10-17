import { describe, expect, it } from 'vitest';
import { needsSystemMessageFixup, normalizeSystemMessages } from './chat-body.js';

describe('normalizeSystemMessages', () => {
  it('merges consecutive leading system messages, stable prompt first', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: 'You are Vega.' },
        { role: 'system', content: 'Context: favorite color is teal.' },
        { role: 'user', content: 'hello' },
      ],
    };
    expect(normalizeSystemMessages(body)).toBe(true);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are Vega.\n\nContext: favorite color is teal.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('turns a later system message into a marked user note in place', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: 'You are Vega.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
        { role: 'system', content: 'Loop warning.' },
        { role: 'user', content: 'again' },
      ],
    };
    expect(normalizeSystemMessages(body)).toBe(true);
    expect((body.messages as { role: string; content: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect((body.messages as { content: string }[])[3]!.content).toBe('[System note]\nLoop warning.');
  });

  it('merges text-part arrays', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'A' }] },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'q' },
      ],
    };
    normalizeSystemMessages(body);
    expect((body.messages as { content: unknown }[])[0]!.content).toBe('A\n\nB');
  });

  it('leaves already-valid bodies untouched', () => {
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }];
    const body: Record<string, unknown> = { messages };
    expect(normalizeSystemMessages(body)).toBe(false);
    expect(body.messages).toBe(messages);
    expect(normalizeSystemMessages({ input: [] })).toBe(false);
  });

  it('only targets self-hosted engines', () => {
    expect(needsSystemMessageFixup('ollamaLocal')).toBe(true);
    expect(needsSystemMessageFixup('lmStudio')).toBe(true);
    expect(needsSystemMessageFixup('openai')).toBe(false);
    expect(needsSystemMessageFixup('aimlapi')).toBe(false);
  });
});
