import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { refreshToken } from '../cloud/pairing.js';
import { loadConfig, saveConfig } from '../utils/config.js';

export class MercuryCloudProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;
  private currentJwt: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

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

    this.refreshIfExpired().catch(() => {});

    this.refreshTimer = setInterval(() => {
      this.refreshIfExpired().catch(() => {});
    }, 5 * 60 * 1000);
  }

  private async refreshIfExpired(): Promise<void> {
    try {
      const parts = this.currentJwt.split('.');
      if (parts.length !== 3) return;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const exp = payload.exp * 1000;
      if (Date.now() > exp - 60_000) {
        const config = loadConfig();
        if (config.cloud.refreshToken) {
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
        }
      }
    } catch {}
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    await this.refreshIfExpired();

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
    await this.refreshIfExpired();

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

  getModelInstance(): any {
    this.refreshIfExpired().catch(() => {});
    return this.modelInstance;
  }
}
