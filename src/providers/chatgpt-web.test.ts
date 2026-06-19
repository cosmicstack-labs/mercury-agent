import { describe, expect, it } from 'vitest';
import { sanitiseBody } from './chatgpt-web.js';

describe('sanitiseBody', () => {
  it('uses non-persistent ChatGPT Codex responses and strips stale item references', () => {
    const sanitized = JSON.parse(sanitiseBody(JSON.stringify({
      model: 'gpt-5.5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'read the project' }] },
        { type: 'item_reference', id: 'rs_example' },
      ],
      store: undefined,
      stream: false,
      max_output_tokens: 4096,
      temperature: 0,
      include: ['reasoning.encrypted_content'],
      instructions: null,
      tools: [{ type: 'function', name: 'list_files' }],
    })));

    expect(sanitized.store).toBe(false);
    expect(sanitized.stream).toBe(true);
    expect(sanitized.instructions).toBe('You are a helpful assistant.');
    expect(sanitized.input).not.toContainEqual({ type: 'item_reference', id: 'rs_example' });
    expect(sanitized.include).toEqual(['reasoning.encrypted_content']);
    expect(sanitized.tools).toEqual([{ type: 'function', name: 'list_files' }]);
    expect(sanitized).not.toHaveProperty('max_output_tokens');
    expect(sanitized).not.toHaveProperty('temperature');
  });
});
