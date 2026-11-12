import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { foldReasoningChunk, foldReasoningMessage, reasoningAsThinkTags, withAnthropicThinking, withThinkTagReasoning } from './reasoning-wire.js';
import { anthropicThinkingOptions, claudeThinking, reasoningLevelsFor, resetModelPrefsCache, setModelPref } from '../utils/model-prefs.js';

/**
 * Reasoning reaches the screen only if the request asks for it (Claude) or
 * the reply's non-standard field is carried through (Chat Completions).
 * These run the real AI SDK providers against a fake fetch and check the
 * wire bodies and the parts that come out.
 */

let home: string;
const previousHome = process.env.MERCURY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-reasoning-'));
  process.env.MERCURY_HOME = home;
  resetModelPrefsCache();
});
afterEach(() => {
  resetModelPrefsCache();
  if (previousHome === undefined) delete process.env.MERCURY_HOME;
  else process.env.MERCURY_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Claude thinking rules', () => {
  it.each([
    ['claude-opus-5-5', true, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5-5', true, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-haiku-5-5', true, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5', true, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5-1', true, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', false, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-7', false, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-6', false, ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-6', false, ['low', 'medium', 'high', 'max']],
    ['anthropic/claude-opus-5-5', true, ['low', 'medium', 'high', 'xhigh', 'max']],
  ] as const)('%s', (model, byDefault, levels) => {
    expect(claudeThinking(model)).toEqual({ thinksByDefault: byDefault, adaptive: true, levels });
    expect(reasoningLevelsFor('anthropic', model)).toEqual(levels);
  });

  it.each(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-7-sonnet-latest', 'claude-sonnet-4-20250514', 'gpt-5'])('%s: nothing sent, no levels', (model) => {
    expect(claudeThinking(model).adaptive).toBe(false);
    expect(reasoningLevelsFor('anthropic', model)).toEqual([]);
    expect(anthropicThinkingOptions(model, 'high')).toBeUndefined();
  });

  it('models that think anyway always get a summary; opt-in models only with an effort', () => {
    expect(anthropicThinkingOptions('claude-opus-5-5', undefined)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
    expect(anthropicThinkingOptions('claude-opus-5-5', 'low')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'low' });
    expect(anthropicThinkingOptions('claude-opus-4-8', undefined)).toBeUndefined();
    expect(anthropicThinkingOptions('claude-opus-4-8', 'xhigh')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' });
    // 4.6 has no xhigh: an effort it can't take is not sent.
    expect(anthropicThinkingOptions('claude-opus-4-6', 'xhigh')).toBeUndefined();
  });
});

function anthropicSse(): Response {
  const usage = { input_tokens: 10, output_tokens: 5 };
  const events = [
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing the options.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('Anthropic requests', () => {
  async function wireBody(model: string): Promise<{ body: Record<string, any>; reasoning: string }> {
    let body: Record<string, any> = {};
    const anthropic = createAnthropic({
      apiKey: 'k',
      fetch: (async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return anthropicSse(); }) as typeof fetch,
    });
    const result = streamText({ model: withAnthropicThinking(anthropic(model), 'anthropic', model), prompt: 'hi' });
    let reasoning = '';
    for await (const part of result.fullStream) if (part.type === 'reasoning-delta') reasoning += part.text;
    return { body, reasoning };
  }

  it('asks Claude 5 models for summarized thinking and streams it as reasoning', async () => {
    const { body, reasoning } = await wireBody('claude-opus-5-5');
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toBeUndefined();
    expect(reasoning).toBe('Weighing the options.');
  });

  it("sends the owner's effort, read on every request", async () => {
    setModelPref('anthropic', 'claude-opus-5-5', { reasoning: 'max' });
    const { body } = await wireBody('claude-opus-5-5');
    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('leaves opt-in models untouched on Auto', async () => {
    const { body } = await wireBody('claude-opus-4-8');
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('Chat Completions reasoning fields', () => {
  it('folds reasoning deltas into a think block closed by the answer', () => {
    const open = new Map<number, boolean>();
    const a = { choices: [{ index: 0, delta: { reasoning_content: 'Let me ' } }] };
    const b = { choices: [{ index: 0, delta: { reasoning: 'think.' } }] };
    const c = { choices: [{ index: 0, delta: { content: 'Answer' } }] };
    foldReasoningChunk(a, open);
    foldReasoningChunk(b, open);
    foldReasoningChunk(c, open);
    expect([a, b, c].map((x) => x.choices[0].delta)).toEqual([
      { content: '<think>Let me ' },
      { content: 'think.' },
      { content: '</think>Answer' },
    ]);
  });

  it('closes the block on a tool call or the end of the choice', () => {
    const open = new Map<number, boolean>();
    foldReasoningChunk({ choices: [{ index: 0, delta: { reasoning_content: 'plan' } }] }, open);
    const tool = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{}' } }] } }] };
    foldReasoningChunk(tool, open);
    expect((tool.choices[0].delta as Record<string, unknown>).content).toBe('</think>');
    foldReasoningChunk({ choices: [{ index: 0, delta: { reasoning: 'more' } }] }, open);
    const end = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    foldReasoningChunk(end, open);
    expect((end.choices[0].delta as Record<string, unknown>).content).toBe('</think>');
  });

  it('leaves ordinary chunks alone', () => {
    const chunk = { choices: [{ index: 0, delta: { content: 'plain' } }] };
    expect(foldReasoningChunk(chunk, new Map())).toBe(false);
    expect(chunk.choices[0].delta).toEqual({ content: 'plain' });
  });

  it('puts a non-streamed reasoning field in front of the content', () => {
    const body = { choices: [{ message: { role: 'assistant', content: 'Hi', reasoning_content: 'why' } }] };
    expect(foldReasoningMessage(body)).toBe(true);
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: '<think>why</think>Hi' });
  });

  it('end to end: an Ollama-style stream comes out as reasoning parts and clean text', async () => {
    const chunks = [
      { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Thinking it ' } }] },
      { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning: 'over.' } }] },
      { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'The answer.' } }] },
      { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    // Split mid-line to exercise the line buffer.
    const raw = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const cut = Math.floor(raw.length / 2);
    const fakeFetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw.slice(0, cut)));
        controller.enqueue(new TextEncoder().encode(raw.slice(cut)));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const openai = createOpenAI({ apiKey: 'k', baseURL: 'http://localhost:1/v1', fetch: reasoningAsThinkTags(fakeFetch) });
    const result = streamText({ model: withThinkTagReasoning(openai.chat('qwen3')), prompt: 'hi' });
    let reasoning = '';
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') reasoning += part.text;
      if (part.type === 'text-delta') text += part.text;
    }
    expect(reasoning).toBe('Thinking it over.');
    expect(text).toBe('The answer.');
  });
});
