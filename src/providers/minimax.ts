import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';

export class MiniMaxProvider extends BaseProvider {
  readonly name = 'minimax';
  readonly model: string;
  private client: ReturnType<typeof createAnthropic>;
  private modelInstance: ReturnType<ReturnType<typeof createAnthropic>['languageModel']>;

  constructor(config: ProviderConfig) {
    super(config);
    this.model = config.model;

    this.client = createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || 'https://api.minimaxi.com/anthropic',
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

    for await (const chunk of result.textStream) {
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
}