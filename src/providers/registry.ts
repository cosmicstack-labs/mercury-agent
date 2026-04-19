import type { MercuryConfig, ProviderConfig } from '../utils/config.js';
import type { BaseProvider } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { logger } from '../utils/logger.js';

export class ProviderRegistry {
  private providers: Map<string, BaseProvider> = new Map();
  private defaultName: string;

  constructor(config: MercuryConfig) {
    this.defaultName = config.providers.default;

    const entries: ProviderConfig[] = [
      config.providers.openai,
      config.providers.anthropic,
      config.providers.deepseek,
    ];

    for (const pc of entries) {
      if (!pc.enabled || !pc.apiKey) continue;
      try {
        const provider = pc.name === 'anthropic'
          ? new AnthropicProvider(pc)
          : new OpenAICompatProvider(pc);
        this.providers.set(pc.name, provider);
        logger.info({ provider: pc.name, model: pc.model }, 'Provider registered');
      } catch (err) {
        logger.warn({ provider: pc.name, err }, 'Failed to register provider');
      }
    }
  }

  get(name?: string): BaseProvider | undefined {
    const key = name || this.defaultName;
    return this.providers.get(key);
  }

  getDefault(): BaseProvider {
    const provider = this.providers.get(this.defaultName);
    if (!provider) {
      const first = this.providers.values().next().value;
      if (!first) throw new Error('No LLM providers available — configure API keys');
      return first;
    }
    return provider;
  }

  listAvailable(): string[] {
    return [...this.providers.keys()];
  }

  hasProviders(): boolean {
    return this.providers.size > 0;
  }
}