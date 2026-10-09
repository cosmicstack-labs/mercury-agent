import type { ProviderConfig } from '../utils/config.js';

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
}

export interface LLMStreamChunk {
  text: string;
  done: boolean;
}

export abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract generateText(prompt: string, systemPrompt: string): Promise<LLMResponse>;
  abstract streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk>;
  abstract isAvailable(): boolean;
  abstract getModelInstance(): any;

  getModel(): string {
    return this.config.model;
  }

  /**
   * Largest `maxOutputTokens` this provider/model accepts, or undefined for
   * "no known ceiling". The agent loop clamps its request to this so a
   * 32K request is not rejected outright and retried at half size.
   */
  getMaxOutputTokens(): number | undefined {
    return this.config.maxOutputTokens;
  }
}