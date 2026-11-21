import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import { withAnthropicThinking } from './reasoning-wire.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { anthropicApiRoot } from './anthropic-url.js';

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: ReturnType<typeof createAnthropic>;
  private modelInstance: ReturnType<typeof withAnthropicThinking>;

  constructor(config: ProviderConfig) {
    super(config);
    this.model = config.model;

    this.client = createAnthropic({
      apiKey: config.apiKey,
      // Without this the configured base URL was ignored and every request
      // went to api.anthropic.com, whatever mercury.yaml said.
      baseURL: anthropicApiRoot(config.baseUrl),
    });
    // Thinking shown as a summary and the owner's effort level, per request.
    this.modelInstance = withAnthropicThinking(this.client(config.model), this.name, config.model);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
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
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    const result = streamText({
      model: this.modelInstance,
      system: systemPrompt,
      prompt,
    });

    for await (const chunk of (await result).textStream) {
      yield { text: chunk, done: false };
    }
    yield { text: '', done: true };
  }

  isAvailable(): boolean {
    return this.config.apiKey.length > 0;
  }

  getModelInstance(): any {
    return this.modelInstance;
  }

  supportsToolResultImages(): boolean {
    return true;
  }
}