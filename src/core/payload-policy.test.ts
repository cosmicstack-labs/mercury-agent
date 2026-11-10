import { describe, expect, it } from 'vitest';
import { isAnthropicModel, KEEP_IMAGES, MAX_TOOL_TEXT_CHARS, shapeStepMessages } from './payload-policy.js';

/** ADR-039: what each model step sends — old screenshots out, oversize results capped, Anthropic cache markers. */

const shot = (id: string) => ({
  role: 'tool',
  content: [{
    type: 'tool-result', toolCallId: id, toolName: 'optimus__look',
    output: { type: 'content', value: [{ type: 'text', text: `screen ${id}` }, { type: 'image-data', data: 'A'.repeat(1000), mediaType: 'image/jpeg' }] },
  }],
});
const call = (id: string) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'optimus__look', input: {} }] });
const base = [{ role: 'system', content: 'S' }, { role: 'user', content: 'open gmail' }];

function images(messages: unknown[]): number {
  return JSON.stringify(messages).split('"image-data"').length - 1;
}

describe('payload policy', () => {
  it('keeps only the newest screenshots; older ones become a note', () => {
    const msgs = [...base, call('1'), shot('1'), call('2'), shot('2'), call('3'), shot('3'), call('4'), shot('4')];
    const out = shapeStepMessages(msgs);
    expect(images(out)).toBe(KEEP_IMAGES);
    expect(JSON.stringify(out[3])).toContain('earlier screenshot was removed');
    expect(JSON.stringify(out[3])).toContain('screen 1'); // the text of the result stays
    expect(JSON.stringify(out[9])).toContain('"image-data"');
    // The conversation the SDK keeps is untouched.
    expect(images(msgs)).toBe(4);
  });

  it('returns the same array when nothing needs to change', () => {
    const msgs = [...base, call('1'), shot('1')];
    expect(shapeStepMessages(msgs)).toBe(msgs);
  });

  it('caps an oversize text result (a base64 blob slipping through) and keeps both ends', () => {
    const blob = `HEAD${'x'.repeat(MAX_TOOL_TEXT_CHARS * 2)}TAIL`;
    const msgs = [...base, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'r', toolName: 'run_command', output: { type: 'text', value: blob } }] }];
    const out = shapeStepMessages(msgs) as unknown as Array<{ content: Array<{ output: { value: string } }> }>;
    const value = out[2].content[0].output.value;
    expect(value.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    expect(value.startsWith('HEAD')).toBe(true);
    expect(value.endsWith('TAIL')).toBe(true);
    expect(value).toContain('characters of this tool result were left out');
  });

  it('caps an oversize JSON result as text', () => {
    const msgs = [...base, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'r', toolName: 'x', output: { type: 'json', value: { data: 'y'.repeat(MAX_TOOL_TEXT_CHARS) } } }] }];
    const out = shapeStepMessages(msgs) as unknown as Array<{ content: Array<{ output: { type: string; value: string } }> }>;
    expect(out[2].content[0].output.type).toBe('text');
    expect(out[2].content[0].output.value.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
  });

  it('Anthropic: the newest two messages carry cache breakpoints, never the system block', () => {
    const msgs = [...base, call('1'), shot('1')];
    const out = shapeStepMessages(msgs, { anthropicCache: true }) as Array<{ role: string; providerOptions?: { anthropic?: { cacheControl?: unknown } } }>;
    const marked = out.map((m) => !!m.providerOptions?.anthropic?.cacheControl);
    expect(marked).toEqual([false, false, true, true]);
    // A single user message after the system prompt: only it is marked.
    const first = shapeStepMessages(base, { anthropicCache: true }) as typeof out;
    expect(first.map((m) => !!m.providerOptions?.anthropic?.cacheControl)).toEqual([false, true]);
  });

  it('keeps other provider options on a marked message', () => {
    const msgs = [...base.slice(0, 1), { role: 'user', content: 'hi', providerOptions: { openai: { x: 1 }, anthropic: { foo: 'bar' } } }];
    const out = shapeStepMessages(msgs, { anthropicCache: true }) as Array<{ providerOptions?: Record<string, Record<string, unknown>> }>;
    expect(out[1].providerOptions).toEqual({ openai: { x: 1 }, anthropic: { foo: 'bar', cacheControl: { type: 'ephemeral' } } });
  });

  it('recognises Anthropic models by their provider id', () => {
    expect(isAnthropicModel({ provider: 'anthropic.messages' })).toBe(true);
    expect(isAnthropicModel({ provider: 'openai.chat' })).toBe(false);
    expect(isAnthropicModel(undefined)).toBe(false);
  });
});
