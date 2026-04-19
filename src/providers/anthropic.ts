import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: ReturnType<typeof createAnthropic>;
  private modelInstance: ReturnType<ReturnType<typeof createAnthropic>['languageModel']>;

  constructor(config: ProviderConfig) {
    super(config);
    this.model = config.model;

    this.client = createAnthropic({
      apiKey: config.apiKey,
    });
    this.modelInstance = this.client(config.model);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    const result = await generateText({
      model: this.modelInstance,
      system: systemPrompt,
      prompt,
    });

    return {
      text: result.text,
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
      totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
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
}