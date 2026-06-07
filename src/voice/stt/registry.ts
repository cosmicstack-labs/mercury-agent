/**
 * STT provider registry. Mirror of tts/registry.ts.
 *
 * Holds the ordered chain `[primary, ...fallbacks]`, constructs providers
 * lazily, caches instances so persistent connections survive across PTT
 * presses. The chain is rebuilt whenever voice config changes.
 */
import type { BaseSTTProvider } from './base.js';
import type { STTProviderName } from '../types.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

type ProviderFactory = () => Promise<BaseSTTProvider>;

const factories = new Map<STTProviderName, ProviderFactory>();
const cache = new Map<STTProviderName, BaseSTTProvider>();

export function registerSTTProvider(name: STTProviderName, factory: ProviderFactory): void {
  factories.set(name, factory);
}

export function knownSTTProviders(): STTProviderName[] {
  return Array.from(factories.keys());
}

export async function getSTTChain(): Promise<BaseSTTProvider[]> {
  const cfg = loadConfig().voice?.stt;
  const preferred = (cfg?.provider as STTProviderName | undefined) ?? 'cartesia';

  const ordered: STTProviderName[] = [];
  if (factories.has(preferred)) ordered.push(preferred);
  for (const name of factories.keys()) {
    if (!ordered.includes(name)) ordered.push(name);
  }

  const chain: BaseSTTProvider[] = [];
  for (const name of ordered) {
    try {
      chain.push(await getOrCreate(name));
    } catch (err) {
      logger.warn({ err, provider: name }, 'voice.stt.registry instantiate failed');
    }
  }
  return chain;
}

export async function pickReadySTT(): Promise<BaseSTTProvider | null> {
  const chain = await getSTTChain();
  for (const p of chain) {
    try {
      if (await p.isAvailable()) return p;
    } catch (err) {
      logger.debug({ err, provider: p.name }, 'voice.stt isAvailable threw');
    }
  }
  return null;
}

export async function disposeSTTProviders(): Promise<void> {
  const all = Array.from(cache.values());
  cache.clear();
  await Promise.allSettled(all.map((p) => p.dispose()));
}

async function getOrCreate(name: STTProviderName): Promise<BaseSTTProvider> {
  const existing = cache.get(name);
  if (existing) return existing;
  const factory = factories.get(name);
  if (!factory) throw new Error(`Unknown STT provider: ${name}`);
  const inst = await factory();
  cache.set(name, inst);
  return inst;
}
