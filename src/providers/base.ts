import type { MercuryConfig, ProviderConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

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

  getModel(): string {
    return this.config.model;
  }
}