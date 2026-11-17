import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider, type MediaEndpoint } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';
import { aimlapiHeaders } from './aimlapi-attribution.js';
import { basicAuthHeaders } from './basic-auth.js';
import { registerSecretValue } from '../utils/redact.js';
import { applyReasoningToBody, effectiveReasoning, isOpenRouterUrl, providerHasReasoningControl } from '../utils/model-prefs.js';
import { rememberCaps } from '../utils/reasoning-caps.js';
import { reasoningAsThinkTags, withThinkTagReasoning, type WireModel } from './reasoning-wire.js';

/**
 * fetch that applies the reasoning level for the requested model (the
 * running chat's override, else the model's default). Done on the wire
 * because the AI SDK drops reasoningEffort for model ids it doesn't
 * recognise as reasoning models (every Ollama model, for one).
 *
 * A server that answers 400 to the effort (an older vLLM, a model without
 * reasoning behind a gateway) gets the same request again without it, and
 * the model is remembered as taking none (reasoning-caps.ts): a wrong guess
 * costs one retry, never a failed turn.
 */
export function withReasoningPref(providerName: string, baseUrl?: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  const openRouter = isOpenRouterUrl(baseUrl);
  return async (input, init) => {
    let model: string | undefined;
    let original: string | undefined;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        model = typeof body.model === 'string' ? body.model : undefined;
        // Only levels this model accepts (e.g. never an effort for gpt-4o).
        const level = model ? effectiveReasoning(providerName, model) : undefined;
        if (level) {
          applyReasoningToBody(body, level, { openRouter });
          original = init.body;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* not JSON — pass through */ }
    }
    const response = await base(input, init);
    if (original === undefined || !model || (response.status !== 400 && response.status !== 422)) return response;
    const text = await response.clone().text().catch(() => '');
    if (!/reasoning|effort|think/i.test(text)) return response;
    rememberCaps(providerName, model, [], 'rejected');
    logger.warn({ provider: providerName, model, status: response.status }, 'Server rejected the reasoning effort; resent without it and stopped sending it for this model');
    return base(input, { ...init, body: original });
  };
}

/**
 * OpenRouter serves the same weights from many hosts. `routing` pins one: the
 * gateway reads a `provider` block in the body (`order`, `quantizations`,
 * `allow_fallbacks`), which the OpenAI SDK has no field for — so it is written
 * on the wire, the same way the reasoning level above is.
 *
 * Only `openrouter` gets this: another gateway that happened to understand the
 * key would be a coincidence, and sending it could be a hard 400.
 */
function withOpenRouterRouting(config: ProviderConfig, base: typeof fetch = globalThis.fetch): typeof fetch {
  const routing = config.routing;
  const order = routing?.order ?? [];
  const quantizations = routing?.quantizations ?? [];
  if (config.name !== 'openrouter' || (order.length === 0 && quantizations.length === 0)) {
    return base;
  }
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body.provider = {
          ...(order.length > 0 ? { order } : {}),
          ...(quantizations.length > 0 ? { quantizations } : {}),
          // A pinned endpoint that is down should fail loudly rather than be
          // swapped for another host behind the caller's back.
          allow_fallbacks: routing?.allowFallbacks ?? false,
        };
        init = { ...init, body: JSON.stringify(body) };
      } catch { /* not JSON — pass through */ }
    }
    return base(input, init);
  };
}

/**
 * The one hook for the wire, composing both body mutations on the same
 * request: the endpoint pin (OpenRouter's `provider` block) and the reasoning
 * level (the effort field). Routing is the inner layer and reasoning wraps it,
 * so a reasoning retry that resends without its field still carries the pin —
 * previously a provider with a reasoning control returned early and silently
 * dropped the other hook's mutation.
 */
function openaiCompatFetch(config: ProviderConfig): typeof fetch | undefined {
  const routed = withOpenRouterRouting(config);
  const reasoning = providerHasReasoningControl(config.name);
  if (!reasoning && routed === globalThis.fetch) return undefined;
  return reasoning ? withReasoningPref(config.name, config.baseUrl, routed) : routed;
}

export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: WireModel;
  private readonly usesResponsesApi: boolean;

  constructor(config: ProviderConfig, { useChatApi }: { useChatApi?: boolean } = {}) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    this.usesResponsesApi = !useChatApi;

    const attribution = aimlapiHeaders(config.baseUrl);
    const basicAuth = basicAuthHeaders(config);
    // So a `cat mercury.yaml` or an error that echoes it never shows the password.
    if (config.password) registerSecretValue(config.password);

    this.client = createOpenAI({
      apiKey: config.apiKey || 'no-key',
      baseURL: config.baseUrl,
      // `undefined` for every host but AI/ML API's, so no other provider
      // reached through this class sends anything extra. Basic auth, when
      // configured, overrides the SDK's Bearer header.
      headers: basicAuth ? { ...attribution, ...basicAuth } : attribution,
      // Only providers with a reasoning control get the hook; the rest keep
      // the SDK's default fetch untouched. Routing (OpenRouter's endpoint pin)
      // composes with it — see openaiCompatFetch.
      // Chat Completions servers also get their reasoning field carried
      // through (reasoning-wire.ts); the Responses API has it natively.
      fetch: useChatApi
        ? reasoningAsThinkTags(openaiCompatFetch(config) ?? globalThis.fetch)
        : openaiCompatFetch(config),
    });
    this.modelInstance = useChatApi
      ? withThinkTagReasoning(this.client.chat(config.model))
      : this.client(config.model);
  }

  async mediaEndpoint(): Promise<MediaEndpoint | undefined> {
    if (!this.config.baseUrl) return undefined;
    const basic = basicAuthHeaders(this.config);
    const attribution = aimlapiHeaders(this.config.baseUrl) ?? {};
    return {
      baseUrl: this.config.baseUrl.replace(/\/+$/, ''),
      headers: { ...attribution, ...(basic ?? (this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})) },
    };
  }

  private formatApiError(err: unknown): Error {
    if (err instanceof Error) {
      const msg = err.message || '';
      // Surface common HTTP error codes with actionable messages
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        return new Error(`[${this.name}] Authentication failed - check your API key or proxy credentials.`);
      }
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        return new Error(`[${this.name}] Model "${this.model}" not found - verify the model name and base URL.`);
      }
      if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many')) {
        return new Error(`[${this.name}] Rate limited - wait a moment before retrying.`);
      }
      return new Error(`[${this.name}] ${msg}`);
    }
    return new Error(`[${this.name}] Unknown error during API call.`);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
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
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
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
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  isAvailable(): boolean {
    // LiteLLM proxies and local Ollama can run without an API key
    if (this.config.name === 'litellm' || this.config.name === 'ollamaLocal') {
      return this.config.baseUrl.length > 0;
    }
    return this.config.apiKey.length > 0 || !!this.config.username;
  }

  getModelInstance(): any {
    return this.modelInstance;
  }

  supportsToolResultImages(): boolean {
    return this.usesResponsesApi && this.name === 'openai';
  }
}