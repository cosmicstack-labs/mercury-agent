import { describe, expect, it } from 'vitest';
import { stepAwareTextStream } from './agent.js';

/**
 * The step-aware text stream inserts a paragraph break at every agentic step
 * boundary — otherwise the SDK's raw concatenation produced word salad in the
 * live tail ("…in this project.Found the situation…"). AI SDK 6 renamed the
 * step-boundary part from 'step-start' to 'start-step'; both names must
 * produce the separator (this test locks the fix for the v6 rename).
 */
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('stepAwareTextStream', () => {
  it('separates narration of consecutive steps under the AI SDK 6 name (start-step)', async () => {
    const fullStream = [
      { type: 'start' },
      { type: 'start-step', request: {}, warnings: [] },
      { type: 'text-delta', id: 't1', text: 'Let me investigate the cloud sync situation in this project.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'run_command', input: {} },
      { type: 'finish-step', usage: {}, finishReason: 'tool-calls', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'start-step', request: {}, warnings: [] },
      { type: 'text-delta', id: 't2', text: 'Found the situation. Let me look deeper at the data layer.' },
      { type: 'finish-step', usage: {}, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} },
    ];
    const text = await collect(stepAwareTextStream(fullStream as any));
    expect(text).toBe(
      'Let me investigate the cloud sync situation in this project.' +
      '\n\n' +
      'Found the situation. Let me look deeper at the data layer.',
    );
  });

  it('keeps the legacy v4/v5 name (step-start) working too', async () => {
    const fullStream = [
      { type: 'start-step' },
      { type: 'text-delta', id: 't1', text: 'first' },
      { type: 'step-start' },
      { type: 'text-delta', id: 't2', text: 'second' },
    ];
    expect(await collect(stepAwareTextStream(fullStream as any))).toBe('first\n\nsecond');
  });

  it('no leading break before the first step, none after a step that only called tools', async () => {
    const fullStream = [
      { type: 'start-step' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'list_dir', input: {} },
      { type: 'start-step' },
      { type: 'text-delta', id: 't1', text: 'narration only here' },
    ];
    expect(await collect(stepAwareTextStream(fullStream as any))).toBe('narration only here');
  });

  it('reasoning deltas surface via the preview callback and never reach the text', async () => {
    const previews: Array<string | null> = [];
    const fullStream = [
      { type: 'start-step' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking hard' },
      { type: 'text-delta', id: 't1', text: 'answer text' },
      { type: 'finish-step', usage: {}, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
    ];
    const text = await collect(stepAwareTextStream(fullStream as any, (p) => previews.push(p)));
    expect(text).toBe('answer text');
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.at(-1)).toBeNull(); // cleared once text starts
  });

  it('every step gets its own thinking block: a tool call or a new step closes it', async () => {
    const events: Array<string | null> = [];
    const fullStream = [
      { type: 'start-step' },
      { type: 'reasoning-delta', id: 'r1', text: 'plan A' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: {} },
      { type: 'start-step' },
      { type: 'reasoning-delta', id: 'r2', text: 'plan B' },
      { type: 'start-step' },
      { type: 'text-delta', id: 't1', text: 'done' },
    ];
    await collect(stepAwareTextStream(fullStream as any, (preview, delta) => events.push(preview === null ? null : delta ?? '')));
    expect(events).toEqual(['plan A', null, 'plan B', null, null]);
  });
});

