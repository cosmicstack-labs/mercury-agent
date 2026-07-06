import { describe, expect, it } from 'vitest';
import { sanitiseBody } from './chatgpt-web.js';

describe('ChatGPT Web request sanitisation', () => {
  it('removes non-persisted Responses API item references when store=false', () => {
    const body = JSON.parse(sanitiseBody(JSON.stringify({
      model: 'gpt-5.5',
      input: [
        { role: 'user', content: 'make an html bunny' },
        { id: 'rs_123', type: 'reasoning', summary: [] },
        { id: 'fc_456', type: 'function_call', name: 'write_file', arguments: '{}' },
        { id: 'call_789', type: 'function_call_output', output: 'ok' },
        { id: 'msg_keep', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
      store: true,
      stream: false,
      max_output_tokens: 4096,
      temperature: 0.2,
    })));

    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.input.map((item: any) => item.id ?? item.role)).toEqual(['user', 'msg_keep']);
  });
});
