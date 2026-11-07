import { describe, expect, it } from 'vitest';
import { sseToJsonResponse } from './chatgpt-web.js';

const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');

interface OutputItem { name: string; arguments: string; encrypted_content: string; content: Array<{ text: string }> }
interface ResponseBody { output: OutputItem[] }

describe('ChatGPT web: rebuilding a whole answer from the stream', () => {
  it('keeps a tool call\'s arguments, which only arrive after the call is announced', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search' };
    const res = await sseToJsonResponse(sse(
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":"Srinagar' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"query":"Srinagar news","kind":"news"}' },
      { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: '{"query":"Srinagar news","kind":"news"}', status: 'completed' } },
      { type: 'response.completed', response: { id: 'r1', output: [] } },
    ));
    const body = (await res.json()) as ResponseBody;
    expect(body.output).toHaveLength(1);
    expect(body.output[0].name).toBe('web_search');
    expect(JSON.parse(body.output[0].arguments)).toEqual({ query: 'Srinagar news', kind: 'news' });
  });

  it('takes arguments from function_call_arguments.done when the item never finishes', async () => {
    const res = await sseToJsonResponse(sse(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'use_skill', arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"name":"web-search"}' },
      { type: 'response.completed', response: { id: 'r2', output: [] } },
    ));
    expect(((await res.json()) as ResponseBody).output[0].arguments).toBe('{"name":"web-search"}');
  });

  it('keeps the reply text and the reasoning item\'s encrypted content', async () => {
    const res = await sseToJsonResponse(sse(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Here is the news.' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.completed', response: { id: 'r3', output: [] } },
    ));
    const body = (await res.json()) as ResponseBody;
    expect(body.output[0].encrypted_content).toBe('enc');
    expect(body.output[1].content[0].text).toBe('Here is the news.');
  });
});
