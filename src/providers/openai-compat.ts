import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';

export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;

  constructor(config: ProviderConfig, { useChatApi }: { useChatApi?: boolean } = {}) {
    super(config);
    this.name = config.name;
    this.model = config.model;

    this.client = createOpenAI({
      apiKey: config.apiKey || 'no-key',
      baseURL: config.baseUrl,
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
}