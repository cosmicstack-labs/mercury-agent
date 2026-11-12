import type { ProviderConfig } from '../utils/config.js';

/** An OpenAI-style HTTP endpoint and its auth, for calls beyond chat (image generation…). */
export interface MediaEndpoint {
  /** Ends in /v1 (or the server's equivalent): "<baseUrl>/images/generations". */
  baseUrl: string;
  headers: Record<string, string>;
}

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

  /** The configured endpoint (empty for providers without one). */
  getBaseUrl(): string {
    return this.config.baseUrl ?? '';
  }

  /**
   * What the owner declared about this endpoint's capability, or undefined when
   * nothing was declared — in which case the name-based guess applies.
   */
  get seesImages(): boolean | undefined {
    return this.config.vision;
  }

  /**
   * Largest `maxOutputTokens` this provider/model accepts, or undefined for
   * "no known ceiling". The agent loop clamps its request to this so a
   * 32K request is not rejected outright and retried at half size.
   */
  getMaxOutputTokens(): number | undefined {
    return this.config.maxOutputTokens;
  }

  supportsToolResultImages(): boolean {
    return false;
  }

  /**
   * Where this provider's OpenAI-style media endpoints live (images, later
   * speech and video), with auth; undefined when it has none Mercury can
   * call (src/media).
   */
  async mediaEndpoint(): Promise<MediaEndpoint | undefined> {
    return undefined;
  }
}