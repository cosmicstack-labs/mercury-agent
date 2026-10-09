import { createDeepSeek } from '@ai-sdk/deepseek';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';

export class DeepSeekProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private modelInstance: any;
  readonly isReasoner: boolean;

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    // Thinking is not only `deepseek-reasoner`: V4-family and any model
    // whose name says reasoner/thinking expose reasoning_content and need
    // thinking enabled (issue #24).
    this.isReasoner = /^deepseek-reasoner$|^deepseek-v4|reasoner|thinking/i.test(config.model);

    const client = createDeepSeek({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.modelInstance = client(config.model);
  }

  async generateText(_prompt: string, _systemPrompt: string): Promise<never> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  async *streamText(_prompt: string, _systemPrompt: string): AsyncIterable<never> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  isAvailable(): boolean {
    return this.config.apiKey.length > 0;
  }

  getModelInstance() {
    return this.modelInstance;
  }

  /** deepseek-chat accepts at most 8K output tokens; reasoning models allow more. */
  getMaxOutputTokens(): number | undefined {
    return this.config.maxOutputTokens ?? (this.isReasoner ? undefined : 8192);
  }
}