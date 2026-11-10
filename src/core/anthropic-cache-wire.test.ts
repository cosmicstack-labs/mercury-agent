import { describe, expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { stepCountIs, streamText, tool, zodSchema } from 'ai';
import { z } from 'zod';
import { ToolDiscovery } from './tool-discovery.js';

/**
 * ADR-039 on the wire: what the real Anthropic SDK sends for a multi-step
 * turn — the system prompt's breakpoint plus two rolling ones on the newest
 * messages, never more than Anthropic's 4, and the conversation of step 1
 * cached for step 2.
 */

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function toolUseTurn(): Response {
  return sse([
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'look', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function textTurn(): Response {
  return sse([
    { type: 'message_start', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}

function cacheMarks(body: { system?: unknown; messages: unknown[] }): string[] {
  const marks: string[] = [];
  const visit = (where: string, node: unknown) => {
    if (Array.isArray(node)) node.forEach((n, i) => visit(`${where}[${i}]`, n));
    else if (node && typeof node === 'object') {
      if ('cache_control' in (node as Record<string, unknown>)) marks.push(where);
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (k !== 'cache_control') visit(`${where}.${k}`, v);
    }
  };
  visit('system', body.system);
  body.messages.forEach((m, i) => visit(`messages[${i}]`, (m as { content: unknown }).content));
  return marks;
}

describe('Anthropic cache breakpoints on the wire', () => {
  it('system + the two newest messages, at most 4, on every step', async () => {
    const bodies: Array<{ system?: unknown; messages: unknown[] }> = [];
    let call = 0;
    const anthropic = createAnthropic({
      apiKey: 'test',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return call++ === 0 ? toolUseTurn() : textTurn();
      },
    });
    const look = tool({ description: 'Look at the screen', inputSchema: zodSchema(z.object({})), execute: async () => 'a screen' });
    const discovery = new ToolDiscovery(() => ({ look }), false);
    const result = streamText({
      model: anthropic('claude-x'),
      allowSystemInMessages: true,
      messages: [
        { role: 'system', content: 'STABLE', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        { role: 'system', content: 'PER TURN' },
        { role: 'user', content: 'what is on my screen?' },
      ],
      ...discovery.request(),
      stopWhen: stepCountIs(3),
    });
    await result.consumeStream();
    expect(bodies).toHaveLength(2);
    // Step 1: the system breakpoint and the user message.
    expect(cacheMarks(bodies[0])).toEqual(['system[0]', 'messages[0][0]']);
    // Step 2: the system breakpoint and the newest two messages (tool call, tool result).
    const marks = cacheMarks(bodies[1]);
    expect(marks[0]).toBe('system[0]');
    expect(marks.length).toBeLessThanOrEqual(4);
    expect(marks.slice(1)).toEqual(['messages[1][0]', 'messages[2][0]']);
    expect(JSON.stringify(bodies[1].system)).toContain('PER TURN');
  });
});
