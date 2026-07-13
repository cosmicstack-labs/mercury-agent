import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { refreshToken } from '../cloud/pairing.js';
import { loadConfig, saveConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export class MercuryCloudProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;
  private currentJwt: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    this.currentJwt = config.apiKey || 'cloud-jwt-placeholder';

    this.client = createOpenAI({
      apiKey: this.currentJwt,
      baseURL: config.baseUrl?.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`,
    });
    this.modelInstance = this.client.chat(config.model);

    this.refreshTimer = setInterval(() => {
      this.refreshIfExpired().catch((err) => {
        logger.warn({ err: err.message }, 'Mercury Cloud periodic token refresh failed');
      });
    }, 3 * 60 * 1000);
  }

  private isTokenExpired(): boolean {
    const parts = this.currentJwt.split('.');
    if (parts.length !== 3) return true;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const exp = payload.exp * 1000;
      return Date.now() > exp - 60_000;
    } catch {
      return true;
    }
  }

  private async refreshIfExpired(): Promise<void> {
    if (!this.isTokenExpired()) return;

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const config = loadConfig();
    if (!config.cloud.refreshToken) {
      logger.warn('No refresh token available — user needs to run `mercury cloud connect`');
      return;
    }

    try {
      const result = await refreshToken(config.cloud.apiUrl, config.cloud.refreshToken);
      this.currentJwt = result.jwt;
      const baseUrl = this.config.baseUrl || config.cloud.apiUrl;
      this.client = createOpenAI({
        apiKey: this.currentJwt,
        baseURL: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
      });
      this.modelInstance = this.client.chat(this.model);
      config.cloud.jwt = result.jwt;
      config.cloud.refreshToken = result.refreshToken;
      config.providers.mercuryCloud.apiKey = result.jwt;
      saveConfig(config);
      logger.info('Mercury Cloud token refreshed');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Mercury Cloud token refresh failed');
      throw err;
    }
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    await this.refreshIfExpired().catch(() => {});

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
      if (this.isRetryableError(err)) {
        logger.warn('Mercury Cloud 401 — refreshing token and retrying...');
        await this.doRefresh().catch(() => {});
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
    await this.refreshIfExpired().catch(() => {});

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
    return this.config.model.length > 0;
  }

  private isRetryableError(err: any): boolean {
    const msg = err?.message || '';
    return msg.includes('401') || msg.includes('Unauthorized') || msg.includes('Forbidden');
  }

  async ensureFreshToken(): Promise<void> {
    await this.refreshIfExpired().catch((err) => {
      logger.warn({ err: err.message }, 'Mercury Cloud token refresh failed');
    });
  }

  async getModelInstanceAsync(): Promise<any> {
    await this.ensureFreshToken();
    return this.modelInstance;
  }

  getModelInstance(): any {
    if (this.isTokenExpired()) {
      this.refreshIfExpired().catch((err) => {
        logger.warn({ err: err.message }, 'Mercury Cloud token refresh failed in getModelInstance');
      });
    }
    return this.modelInstance;
  }
}
