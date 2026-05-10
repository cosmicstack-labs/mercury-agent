import { createOpenAI } from '@ai-sdk/openai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { getValidChatGPTSession, getChatGPTSession } from '../auth/chatgpt-auth.js';
import { CHATGPT_BACKEND_API } from '../auth/chatgpt-session.js';
import { logger } from '../utils/logger.js';

// Fields the codex endpoint does not accept
const UNSUPPORTED_FIELDS = [
  'max_output_tokens', 'temperature', 'top_p',
  'frequency_penalty', 'presence_penalty',
  'service_tier', 'user',
];

/**
 * Sanitise an outgoing request body for the ChatGPT codex/responses endpoint.
 */
function sanitiseBody(raw: string): string {
  const body = JSON.parse(raw);

  // Required
  body.store = false;
  body.stream = true;
  if (!body.instructions) body.instructions = 'You are a helpful assistant.';

  // Strip unsupported & undefined/null
  for (const key of UNSUPPORTED_FIELDS) delete body[key];
  for (const key of Object.keys(body)) {
    if (body[key] === undefined || body[key] === null) delete body[key];
  }

  return JSON.stringify(body);
}

/**
 * Consume an SSE stream and build a complete Responses API JSON payload.
 * The codex endpoint's `response.completed` event has empty `output`,
 * so we reconstruct it from intermediate events.
 * Returns a synthetic JSON Response so the SDK's doGenerate can parse it.
 */
async function sseToJsonResponse(sseResponse: Response): Promise<Response> {
  const text = await sseResponse.text();
  const lines = text.split('\n');

  let responseObj: Record<string, any> | null = null;
  const outputItems: Record<string, any>[] = [];
  const contentParts: Map<string, any[]> = new Map(); // itemId → parts[]

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    let parsed: any;
    try { parsed = JSON.parse(data); } catch { continue; }

    switch (parsed.type) {
      case 'response.completed':
        responseObj = parsed.response;
        break;
      case 'response.output_item.added':
        if (parsed.item) {
          outputItems[parsed.output_index] = { ...parsed.item, content: [] };
        }
        break;
      case 'response.output_text.done':
        // Attach completed text to the right output item
        if (parsed.output_index !== undefined) {
          const item = outputItems[parsed.output_index];
          if (item) {
            if (!item.content) item.content = [];
            item.content[parsed.content_index ?? 0] = {
              type: 'output_text',
              text: parsed.text ?? '',
              annotations: [],
            };
          }
        }
        break;
      case 'response.content_part.done':
        // Also capture from content_part.done as fallback
        if (parsed.part && parsed.output_index !== undefined) {
          const item = outputItems[parsed.output_index];
          if (item && !item.content?.[parsed.content_index ?? 0]) {
            if (!item.content) item.content = [];
            item.content[parsed.content_index ?? 0] = parsed.part;
          }
        }
        break;
    }
  }

  if (!responseObj) {
    return new Response(JSON.stringify({ error: { message: 'No response.completed event found' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Reconstruct output with the text we collected
  responseObj.output = outputItems.filter(Boolean);

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class ChatGPTWebProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private cachedModelInstance: any = null;
  private cachedAccessToken: string = '';

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;
  }

  async generateText(_prompt: string, _systemPrompt: string): Promise<LLMResponse> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  async *streamText(_prompt: string, _systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  isAvailable(): boolean {
    const session = getChatGPTSession();
    return session !== null && session.accessToken.length > 0;
  }

  getModelInstance(): any {
    const session = getChatGPTSession();

    if (!session?.accessToken || !session?.accountId) {
      logger.warn('ChatGPT Web: no valid session — requests will fail');
    }

    const accessToken = session?.accessToken ?? '';
    const accountId = session?.accountId ?? '';

    // Rebuild the model instance if token changed or first call
    if (!this.cachedModelInstance || accessToken !== this.cachedAccessToken) {
      this.cachedAccessToken = accessToken;

      // Kick off async token refresh in background if needed
      if (session && !this._isTokenFresh(session)) {
        getValidChatGPTSession().catch((err) => {
          logger.warn({ err }, 'Background token refresh failed');
        });
      }

      const client = createOpenAI({
        apiKey: 'chatgpt-oauth-token', // dummy — real auth is in custom fetch
        baseURL: `${CHATGPT_BACKEND_API}/codex`,
        fetch: async (url, init) => {
          // Inject OAuth headers
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${accessToken}`);
          headers.set('ChatGPT-Account-Id', accountId);
          headers.set('User-Agent', `mercury-agent/1.0 (${process.platform} ${process.arch})`);
          headers.delete('api-key');

          // Detect whether the SDK requested streaming
          let wasStreaming = false;
          let modifiedInit = { ...init, headers };

          if (init?.body && typeof init.body === 'string') {
            try {
              const parsed = JSON.parse(init.body);
              wasStreaming = parsed.stream === true;
            } catch { /* ignore */ }

            try {
              modifiedInit.body = sanitiseBody(init.body);
            } catch { /* pass through */ }
          }

          const response = await globalThis.fetch(url, modifiedInit);

          // If the SDK did NOT request streaming (doGenerate path),
          // the codex endpoint still returns SSE because we forced stream:true.
          // Consume the SSE and return a synthetic JSON response.
          if (!wasStreaming && response.ok) {
            return sseToJsonResponse(response);
          }

          return response;
        },
      });

      // Use the Responses API (not Chat Completions)
      this.cachedModelInstance = client.responses(this.model as any);
    }

    return this.cachedModelInstance;
  }

  private _isTokenFresh(session: { expiresAt: string }): boolean {
    if (!session.expiresAt) return true;
    return Date.now() < new Date(session.expiresAt).getTime() - 120_000;
  }
}
