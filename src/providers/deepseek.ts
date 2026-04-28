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
    this.isReasoner = config.model === 'deepseek-reasoner';

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
}