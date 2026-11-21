import { generateText } from 'ai';
import type { ProviderRegistry } from '../providers/registry.js';
import type { BaseProvider } from '../providers/base.js';
import { modelSeesImages } from './attachments.js';
import { logger } from '../utils/logger.js';

/**
 * One question about one image, answered by the owner's own models: whatever
 * providers they set up (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, any
 * OpenAI-compatible server…), the default first, then the rest in Mercury's
 * fallback order. Models that can't see images are skipped. Used by plugins
 * through ctx.models.lookAt (e.g. reading a CAPTCHA before paying a service).
 */

let registry: ProviderRegistry | null = null;
export function setLookRegistry(r: ProviderRegistry | null): void { registry = r; }

export interface LookResult { text: string; provider: string; model: string }

const PER_PROVIDER_MS = 45_000;

export function visionCapable(p: BaseProvider): boolean {
  try { return modelSeesImages(p.name, p.getModel(), p.seesImages); } catch { return false; }
}

export async function lookWithOwnModels(input: {
  prompt: string;
  image: { data: Uint8Array; mimeType: string };
  /** How many models to try at most (default 3). */
  maxModels?: number;
  maxOutputTokens?: number;
  /** Providers not to use (e.g. the one that already answered, for a second opinion). */
  exclude?: string[];
  signal?: AbortSignal;
}): Promise<LookResult | null> {
  if (!registry || !registry.hasProviders()) return null;
  const tries = Math.max(1, Math.min(input.maxModels ?? 3, 6));
  let tried = 0;
  for (const provider of registry.getFallbackIterator()) {
    if (tried >= tries || input.signal?.aborted) break;
    if (input.exclude?.includes(provider.name) || !registry.isUsable(provider.name) || !visionCapable(provider)) continue;
    tried++;
    const timeout = AbortSignal.timeout(PER_PROVIDER_MS);
    try {
      const result = await generateText({
        model: provider.getModelInstance(),
        messages: [{ role: 'user', content: [
          { type: 'text', text: input.prompt },
          { type: 'image', image: input.image.data, mediaType: input.image.mimeType },
        ] }],
        maxOutputTokens: input.maxOutputTokens ?? 200,
        abortSignal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      });
      const text = result.text.trim();
      if (text) return { text, provider: provider.name, model: provider.getModel() };
    } catch (err) {
      logger.info({ provider: provider.name, err: (err as Error).message?.slice(0, 200) }, 'lookWithOwnModels: provider failed, trying the next');
    }
  }
  return null;
}
