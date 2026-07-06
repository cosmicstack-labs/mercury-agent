import { createOpenAI } from '@ai-sdk/openai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';

export class OpenRouterProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private modelInstance: any;

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;

    const client = createOpenAI({
      apiKey: config.apiKey || 'no-key',
      baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
      name: 'openrouter',
      headers: {
        'HTTP-Referer': 'https://mercuryagent.ai',
        'X-Title': 'Mercury Agent',
      },
    });
    this.modelInstance = client.chat(config.model);
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