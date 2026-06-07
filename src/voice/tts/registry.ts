/**
 * TTS provider registry.
 *
 * Holds the ordered chain `[primary, ...fallbacks]` and constructs each
 * provider lazily on first use. Providers report availability via
 * `isAvailable()`; the registry walks the chain to pick the first ready
 * one. The chain is rebuilt whenever the user changes voice config.
 *
 * Keep this file free of provider-internal logic — it should just compose
 * provider modules so they can be swapped or unit-tested in isolation.
 */
import type { BaseTTSProvider } from './base.js';
import type { TTSProviderName } from '../types.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

type ProviderFactory = () => Promise<BaseTTSProvider>;

const factories = new Map<TTSProviderName, ProviderFactory>();

/**
 * Register a provider factory. Called once per provider module at module
 * load time (see cartesia.ts / openai.ts).
 */
export function registerTTSProvider(name: TTSProviderName, factory: ProviderFactory): void {
  factories.set(name, factory);
}

/** All known provider names (whether or not currently available). */
export function knownTTSProviders(): TTSProviderName[] {
  return Array.from(factories.keys());
}

/**
 * Build the configured chain. Order:
 *   1. voice.tts.provider (preferred)
 *   2. remaining known providers in registration order, deduped
 *
 * Each provider is instantiated lazily; we cache instances by name so
 * persistent resources (Cartesia WS) survive across utterances.
 */
const cache = new Map<TTSProviderName, BaseTTSProvider>();

export async function getTTSChain(): Promise<BaseTTSProvider[]> {
  const cfg = loadConfig().voice?.tts;
  const preferred = (cfg?.provider as TTSProviderName | undefined) ?? 'cartesia';

  const ordered: TTSProviderName[] = [];
  if (factories.has(preferred)) ordered.push(preferred);
  for (const name of factories.keys()) {
    if (!ordered.includes(name)) ordered.push(name);
  }

  const chain: BaseTTSProvider[] = [];
  for (const name of ordered) {
    try {
      const inst = await getOrCreate(name);
      chain.push(inst);
    } catch (err) {
      logger.warn({ err, provider: name }, 'voice.tts.registry instantiate failed');
    }
  }
  return chain;
}

/** Pick the first ready provider, or null if none are available. */
export async function pickReadyTTS(): Promise<BaseTTSProvider | null> {
  const chain = await getTTSChain();
  for (const p of chain) {
    try {
      if (await p.isAvailable()) return p;
    } catch (err) {
      logger.debug({ err, provider: p.name }, 'voice.tts isAvailable threw');
    }
  }
  return null;
}

/** Tear down all cached providers. Idempotent. */
export async function disposeTTSProviders(): Promise<void> {
  const all = Array.from(cache.values());
  cache.clear();
  await Promise.allSettled(all.map((p) => p.dispose()));
}

async function getOrCreate(name: TTSProviderName): Promise<BaseTTSProvider> {
  const existing = cache.get(name);
  if (existing) return existing;
  const factory = factories.get(name);
  if (!factory) throw new Error(`Unknown TTS provider: ${name}`);
  const inst = await factory();
  cache.set(name, inst);
  return inst;
}
