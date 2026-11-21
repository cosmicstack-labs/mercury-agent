import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import { bedrockCredentialProvider, bedrockRegion } from './bedrock-auth.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';

type BedrockModel = ReturnType<ReturnType<typeof createAmazonBedrock>>;

/**
 * Amazon Bedrock through its Converse API. Requests are SigV4-signed inside
 * Mercury with credentials from the AWS chain (see bedrock-auth.ts), or sent
 * with a Bedrock API key when one is configured. No proxy process is needed.
 */
export class BedrockProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private modelInstance: BedrockModel;

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;

    const client = createAmazonBedrock({
      region: bedrockRegion(config),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      // A Bedrock API key takes precedence over SigV4 inside the SDK.
      ...(config.apiKey
        ? { apiKey: config.apiKey }
        : { credentialProvider: bedrockCredentialProvider(config) }),
    });
    this.modelInstance = client(config.model);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    const result = await generateText({ model: this.modelInstance, system: systemPrompt, prompt });
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    return {
      text: result.text,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: this.model,
      provider: this.name,
    };
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    const result = streamText({ model: this.modelInstance, system: systemPrompt, prompt });
    for await (const chunk of result.textStream) {
      yield { text: chunk, done: false };
    }
    yield { text: '', done: true };
  }

  /** Credentials are resolved per request, so a configured model is enough. */
  isAvailable(): boolean {
    return this.config.model.length > 0;
  }

  getModelInstance(): BedrockModel {
    return this.modelInstance;
  }
}
