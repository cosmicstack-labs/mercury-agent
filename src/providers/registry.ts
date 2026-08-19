import type { MercuryConfig, ProviderConfig } from '../utils/config.js';
import { isProviderConfigured } from '../utils/config.js';
import type { BaseProvider } from './base.js';
import { logger } from '../utils/logger.js';

export async function createProvider(pc: ProviderConfig, tokenStore?: import('../cloud/token-store.js').CloudTokenStore | null): Promise<BaseProvider> {
  if (pc.name === 'mercuryCloud') {
    const { MercuryCloudProvider } = await import('./mercury-cloud.js');
    return new MercuryCloudProvider(pc, tokenStore ?? null);
  } else if (pc.name === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.js');
    return new AnthropicProvider(pc);
  } else if (pc.name === 'deepseek') {
    const { DeepSeekProvider } = await import('./deepseek.js');
    return new DeepSeekProvider(pc);
  } else if (pc.name === 'ollamaLocal') {
    // Route through OpenAI-compatible provider — local Ollama exposes
    // /v1/chat/completions since v0.1.14. The ollama-ai-provider package
    // declares specificationVersion = "v1" which is incompatible with
    // AI SDK v6 (requires v2/v3). Using the OpenAI compat path avoids
    // this entirely.
    const { OpenAICompatProvider } = await import('./openai-compat.js');
    return new OpenAICompatProvider(pc, { useChatApi: true });
  } else if (pc.name === 'atlascloud' || pc.name === 'ollamaCloud' || pc.name === 'openaiCompat') {
    const { OpenAICompatProvider } = await import('./openai-compat.js');
    return new OpenAICompatProvider(pc, { useChatApi: true });
  } else if (pc.name === 'mimo' || pc.name === 'mimoTokenPlan') {
    const { MiMoProvider } = await import('./mimo.js');
    return new MiMoProvider(pc);
  } else if (pc.name === 'chatgptWeb') {
    const { ChatGPTWebProvider } = await import('./chatgpt-web.js');
    return new ChatGPTWebProvider(pc);
  } else if (pc.name === 'githubCopilot') {
    const { GitHubCopilotProvider } = await import('./github-copilot.js');
    return new GitHubCopilotProvider(pc);
  } else {
    const { OpenAICompatProvider } = await import('./openai-compat.js');
    return new OpenAICompatProvider(pc);
  }
}

export class ProviderRegistry {
  private providers: Map<string, BaseProvider> = new Map();
  private defaultName: string;
  private lastSuccessful: string | null = null;

  private constructor(defaultName: string) {
    this.defaultName = defaultName;
  }

  static async create(config: MercuryConfig, tokenStore?: import('../cloud/token-store.js').CloudTokenStore | null): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry(config.providers.default);

    const entries: ProviderConfig[] = [
      {
        ...config.providers.mercuryCloud,
        apiKey: config.providers.mercuryCloud.apiKey || config.cloud.jwt,
        baseUrl: config.cloud.apiUrl || config.providers.mercuryCloud.baseUrl,
      },
      config.providers.deepseek,
      config.providers.openai,
      config.providers.anthropic,
      config.providers.grok,
      config.providers.atlascloud,
      config.providers.ollamaCloud,
      config.providers.ollamaLocal,
      config.providers.openaiCompat,
      config.providers.mimo,
      config.providers.mimoTokenPlan,
      config.providers.chatgptWeb,
      config.providers.githubCopilot,
    ];

    // Load only configured providers in parallel
    const configured = entries.filter(pc => isProviderConfigured(pc));
    const results = await Promise.allSettled(
      configured.map(async (pc) => {
        const provider = await createProvider(pc, pc.name === 'mercuryCloud' ? tokenStore : undefined);
        return { name: pc.name, model: pc.model, provider };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { name, model, provider } = result.value;
        registry.providers.set(name, provider);
        logger.info({ provider: name, model }, 'Provider registered');
      } else {
        logger.warn({ err: result.reason }, 'Failed to register provider');
      }
    }

    return registry;
  }

  get(name?: string): BaseProvider | undefined {
    const key = name || this.defaultName;
    return this.providers.get(key);
  }

  set(name: string, provider: BaseProvider): void {
    const existing = this.providers.get(name) as (BaseProvider & { destroy?: () => void }) | undefined;
    existing?.destroy?.();
    this.providers.set(name, provider);
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) throw new Error(`Provider is not registered: ${name}`);
    this.defaultName = name;
    this.lastSuccessful = null;
  }

  updateApiKey(name: string, apiKey: string): void {
    const provider = this.providers.get(name) as (BaseProvider & { updateToken?: (token: string) => void }) | undefined;
    provider?.updateToken?.(apiKey);
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

  getFallbackIterator(preferredName?: string): IterableIterator<BaseProvider> {
    const ordered: BaseProvider[] = [];
    const preferredProvider = preferredName ? this.providers.get(preferredName) : undefined;
    const defaultProvider = preferredProvider || this.getDefault();
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

  destroy(): void {
    for (const provider of this.providers.values()) {
      (provider as BaseProvider & { destroy?: () => void }).destroy?.();
    }
    this.providers.clear();
  }
}
