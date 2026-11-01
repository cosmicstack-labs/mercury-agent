import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';
import { aimlapiHeaders } from './aimlapi-attribution.js';
import { applyReasoningToBody, effectiveReasoning, providerHasReasoningControl } from '../utils/model-prefs.js';

/**
 * fetch that applies the user's reasoning level for the requested model.
 * Done on the wire because the AI SDK drops reasoningEffort for model ids it
 * doesn't recognise as reasoning models (every Ollama model, for one).
 */
function withReasoningPref(providerName: string): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        // Only levels this model accepts (e.g. never an effort for gpt-4o).
        const level = typeof body.model === 'string' ? effectiveReasoning(providerName, body.model) : undefined;
        if (level) {
          applyReasoningToBody(body, level);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* not JSON — pass through */ }
    }
    return globalThis.fetch(input, init);
  };
}

export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;
  private readonly usesResponsesApi: boolean;

  constructor(config: ProviderConfig, { useChatApi }: { useChatApi?: boolean } = {}) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    this.usesResponsesApi = !useChatApi;

    this.client = createOpenAI({
      apiKey: config.apiKey || 'no-key',
      baseURL: config.baseUrl,
      // `undefined` for every host but AI/ML API's, so no other provider
      // reached through this class sends anything extra.
      headers: aimlapiHeaders(config.baseUrl),
      // Only providers with a reasoning control get the hook; the rest keep
      // the SDK's default fetch untouched.
      fetch: providerHasReasoningControl(config.name) ? withReasoningPref(config.name) : undefined,
    });
    this.modelInstance = useChatApi
      ? this.client.chat(config.model)
      : this.client(config.model);
  }

  private formatApiError(err: unknown): Error {
    if (err instanceof Error) {
      const msg = err.message || '';
      // Surface common HTTP error codes with actionable messages
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        return new Error(`[${this.name}] Authentication failed - check your API key or proxy credentials.`);
      }
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        return new Error(`[${this.name}] Model "${this.model}" not found - verify the model name and base URL.`);
      }
      if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many')) {
        return new Error(`[${this.name}] Rate limited - wait a moment before retrying.`);
      }
      return new Error(`[${this.name}] ${msg}`);
    }
    return new Error(`[${this.name}] Unknown error during API call.`);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    try {
      const result = await generateText({
        model: this.modelInstance,
        system: systemPrompt,
        prompt,
      });

      return {
        text: result.text,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        model: this.model,
        provider: this.name,
      };
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    try {
      const result = streamText({
        model: this.modelInstance,
        system: systemPrompt,
        prompt,
      });

      for await (const chunk of (await result).textStream) {
        yield { text: chunk, done: false };
      }
      yield { text: '', done: true };
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  isAvailable(): boolean {
    // LiteLLM proxies and local Ollama can run without an API key
    if (this.config.name === 'litellm' || this.config.name === 'ollamaLocal') {
      return this.config.baseUrl.length > 0;
    }
    return this.config.apiKey.length > 0;
  }

  getModelInstance(): any {
    return this.modelInstance;
  }

  supportsToolResultImages(): boolean {
    return this.usesResponsesApi && this.name === 'openai';
  }
}