import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';
import type { CloudTokenStore } from '../cloud/token-store.js';

export class MercuryCloudProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;
  private tokenStore: CloudTokenStore | null;
  private removeTokenListener: (() => void) | null = null;

  constructor(config: ProviderConfig, tokenStore: CloudTokenStore | null = null) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    this.tokenStore = tokenStore;

    const jwt = tokenStore?.getJwt() ?? config.apiKey ?? 'cloud-jwt-placeholder';
    this.client = createOpenAI({
      apiKey: jwt,
      baseURL: config.baseUrl?.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`,
      headers: this.cloudHeaders(),
    });
    this.modelInstance = this.client.chat(config.model);

    // Swap the cached JWT whenever the shared token store rotates. This
    // replaces the old independent 3-minute proactive refresh timer, which
    // raced the WS client for the single-use refresh token and eventually
    // burned it.
    if (tokenStore) {
      this.removeTokenListener = tokenStore.addListener((tokens) => {
        this.rebuildClient(tokens.jwt);
      });
    }
  }

  private cloudHeaders(): Record<string, string> | undefined {
    if (!this.tokenStore) return undefined;
    const headers: Record<string, string> = { 'X-Agent-Id': this.tokenStore.getAgentId() };
    const apiKey = this.tokenStore.getAgentApiKey();
    if (apiKey) headers['X-Agent-Api-Key'] = apiKey;
    return headers;
  }

  private rebuildClient(jwt: string): void {
    const baseUrl = this.config.baseUrl || '';
    this.client = createOpenAI({
      apiKey: jwt,
      baseURL: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
      headers: this.cloudHeaders(),
    });
    this.modelInstance = this.client.chat(this.model);
  }

  destroy(): void {
    this.removeTokenListener?.();
    this.removeTokenListener = null;
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    await this.ensureFreshToken().catch(() => {});

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
    } catch (err: any) {
      if (this.isRetryableError(err) && this.tokenStore) {
        logger.warn('Mercury Cloud 401 — refreshing token and retrying...');
        try {
          const rotated = await this.tokenStore.rotate();
          this.rebuildClient(rotated.jwt);
        } catch (rotateErr: any) {
          logger.warn({ err: rotateErr.message }, 'Mercury Cloud reactive refresh failed');
          throw err;
        }
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
      throw err;
    }
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    await this.ensureFreshToken().catch(() => {});

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
    } catch (err: any) {
      // streamText previously had no 401-retry path, which meant a streaming
      // chat would fail where a non-streaming chat would recover. Retry once
      // after a reactive rotation.
      if (!this.isRetryableError(err) || !this.tokenStore) throw err;
      logger.warn('Mercury Cloud stream 401 — refreshing token and retrying...');
      try {
        const rotated = await this.tokenStore.rotate();
        this.rebuildClient(rotated.jwt);
      } catch (rotateErr: any) {
        logger.warn({ err: rotateErr.message }, 'Mercury Cloud reactive stream refresh failed');
        throw err;
      }
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
  }

  isAvailable(): boolean {
    return this.config.model.length > 0;
  }

  private isRetryableError(err: any): boolean {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status;
    if (typeof status === 'number') return status === 401;
    const msg = err?.message || '';
    return msg.includes('401') || msg.includes('Unauthorized');
  }

  async ensureFreshToken(): Promise<void> {
    if (!this.tokenStore) return;
    try {
      const jwt = await this.tokenStore.rotateIfExpired();
      this.rebuildClient(jwt);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Mercury Cloud token refresh failed');
    }
  }

  async getModelInstanceAsync(): Promise<any> {
    await this.ensureFreshToken();
    return this.modelInstance;
  }

  getModelInstance(): any {
    if (this.tokenStore?.isJwtNearExpiry()) {
      this.tokenStore.rotateIfExpired().catch((err) => {
        logger.warn({ err: err.message }, 'Mercury Cloud token refresh failed in getModelInstance');
      });
    }
    return this.modelInstance;
  }
}
