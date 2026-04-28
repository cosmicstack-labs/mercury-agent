import type { MercuryConfig, ProviderConfig } from '../utils/config.js';
import { isProviderConfigured } from '../utils/config.js';
import type { BaseProvider } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import { OllamaProvider } from './ollama.js';
import { MiMoProvider } from './mimo.js';
import { logger } from '../utils/logger.js';

export class ProviderRegistry {
  private providers: Map<string, BaseProvider> = new Map();
  private defaultName: string;
  private lastSuccessful: string | null = null;

  constructor(config: MercuryConfig) {
    this.defaultName = config.providers.default;

    const entries: ProviderConfig[] = [
      config.providers.deepseek,
      config.providers.openai,
      config.providers.anthropic,
      config.providers.grok,
      config.providers.ollamaCloud,
      config.providers.ollamaLocal,
      config.providers.mimo,
      config.providers.mimoTokenPlan,
    ];

    for (const pc of entries) {
      if (!isProviderConfigured(pc)) continue;
      try {
        let provider: BaseProvider;
        if (pc.name === 'anthropic') {
          provider = new AnthropicProvider(pc);
        } else if (pc.name === 'deepseek') {
          provider = new DeepSeekProvider(pc);
        } else if (pc.name === 'ollamaCloud' || pc.name === 'ollamaLocal') {
          provider = new OllamaProvider(pc);
        } else if (pc.name === 'mimo' || pc.name === 'mimoTokenPlan') {
          provider = new MiMoProvider(pc);
        } else {
          provider = new OpenAICompatProvider(pc);
        }
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
    if (this.lastSuccessful) {
      const provider = this.providers.get(this.lastSuccessful);
      if (provider) return provider;
    }

    const provider = this.providers.get(this.defaultName);
    if (!provider) {
      const first = this.providers.values().next().value;
      if (!first) throw new Error('No LLM providers available — configure API keys');
      return first;
    }
    return provider;
  }

  getFallbackIterator(): IterableIterator<BaseProvider> {
    const ordered: BaseProvider[] = [];
    const defaultProvider = this.getDefault();
    ordered.push(defaultProvider);
    for (const [, provider] of this.providers) {
      if (provider !== defaultProvider) {
        ordered.push(provider);
      }
    }
    return ordered[Symbol.iterator]();
  }

  markSuccess(name: string): void {
    this.lastSuccessful = name;
  }

  listAvailable(): string[] {
    return [...this.providers.keys()];
  }

  hasProviders(): boolean {
    return this.providers.size > 0;
  }
}
