/**
 * Getting a model's reasoning onto the screen, per wire format.
 *
 * - Anthropic: the request has to ask for it. Claude 5-era models think by
 *   default but return empty thinking blocks unless the request says
 *   display "summarized"; the owner's effort level rides on the same call.
 *   Applied per call (middleware), so a level changed in the desktop takes
 *   effect on the next request without rebuilding the provider.
 * - Chat Completions servers (Ollama, LM Studio, vLLM, LiteLLM, llama.cpp…):
 *   reasoning arrives in a non-standard `reasoning_content` / `reasoning`
 *   field that the AI SDK's OpenAI chat parser ignores. The fetch below
 *   folds it into the content as <think>…</think>, and the SDK's
 *   extractReasoningMiddleware turns that back into proper reasoning parts.
 *   Models that already write <think> tags into their content are handled
 *   by the same middleware.
 */
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { anthropicThinkingOptions, effectiveReasoning } from '../utils/model-prefs.js';

/** The model type wrapLanguageModel takes and returns. */
export type WireModel = Parameters<typeof wrapLanguageModel>[0]['model'];

/** Anthropic: summarized thinking where the model thinks, plus the chosen effort. */
export function anthropicThinkingMiddleware(providerName: string, model: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const extra = anthropicThinkingOptions(model, effectiveReasoning(providerName, model));
      if (!extra) return params;
      const providerOptions = (params.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
      const anthropic = providerOptions.anthropic ?? {};
      return {
        ...params,
        providerOptions: {
          ...providerOptions,
          // A caller's explicit thinking/effort wins.
          anthropic: { ...extra, ...anthropic },
        },
      } as typeof params;
    },
  };
}

export function withAnthropicThinking(model: WireModel, providerName: string, modelId: string): WireModel {
  return wrapLanguageModel({ model, middleware: anthropicThinkingMiddleware(providerName, modelId) });
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function reasoningOf(part: Record<string, unknown> | undefined): string | undefined {
  if (!part) return undefined;
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const value = part[key];
    if (typeof value === 'string') {
      delete part[key];
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Rewrite one parsed streaming chunk in place. `open` tracks, per choice,
 * whether a <think> block is currently open. Returns true if it changed.
 */
export function foldReasoningChunk(chunk: unknown, open: Map<number, boolean>): boolean {
  const choices = (chunk as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const raw of choices) {
    const choice = raw as { index?: number; delta?: Record<string, unknown>; finish_reason?: unknown };
    const idx = typeof choice.index === 'number' ? choice.index : 0;
    const delta = choice.delta;
    const reasoning = reasoningOf(delta);
    if (reasoning !== undefined || (delta && ('reasoning_content' in delta || 'reasoning' in delta))) changed = true;
    const content = typeof delta?.content === 'string' ? delta.content : '';
    const hasToolCalls = Array.isArray(delta?.tool_calls) && delta!.tool_calls.length > 0;
    let prefix = '';
    if (reasoning) {
      prefix = (open.get(idx) ? '' : THINK_OPEN) + reasoning;
      open.set(idx, true);
    }
    // The answer, a tool call or the end of the choice closes the block.
    if (open.get(idx) && (content || hasToolCalls || choice.finish_reason)) {
      prefix += THINK_CLOSE;
      open.set(idx, false);
    }
    if (prefix) {
      if (!choice.delta) choice.delta = {};
      choice.delta.content = prefix + content;
      changed = true;
    }
  }
  return changed;
}

/** Non-streaming response: put the reasoning in front of the content as a think block. */
export function foldReasoningMessage(body: unknown): boolean {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const raw of choices) {
    const message = (raw as { message?: Record<string, unknown> }).message;
    const reasoning = reasoningOf(message);
    if (!message || !reasoning) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    message.content = `${THINK_OPEN}${reasoning}${THINK_CLOSE}${content}`;
    changed = true;
  }
  return changed;
}

function foldEventStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const open = new Map<number, boolean>();
  let pending = '';
  const rewriteLine = (line: string): string => {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || m[1].trim() === '[DONE]' || !m[1].trim()) return line;
    try {
      const chunk = JSON.parse(m[1]);
      return foldReasoningChunk(chunk, open) ? `data: ${JSON.stringify(chunk)}` : line;
    } catch {
      return line;
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.length) controller.enqueue(encoder.encode(lines.map(rewriteLine).join('\n') + '\n'));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewriteLine(pending)));
    },
  }));
}

/** fetch for Chat Completions providers that carries reasoning fields through as think tags. */
export function reasoningAsThinkTags(base: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.ok || !response.body) return response;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(foldEventStream(response.body), { status: response.status, statusText: response.statusText, headers });
    }
    if (type.includes('application/json')) {
      const text = await response.text();
      let out = text;
      try {
        const parsed = JSON.parse(text);
        if (foldReasoningMessage(parsed)) out = JSON.stringify(parsed);
      } catch { /* not JSON after all — pass it on untouched */ }
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(out, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  };
}

/** A Chat Completions model whose <think> blocks come out as reasoning parts. */
export function withThinkTagReasoning(model: WireModel): WireModel {
  return wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: 'think' }) });
}
