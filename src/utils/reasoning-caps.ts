/**
 * Which effort levels a model behind an OpenAI-compatible server takes.
 *
 * Nothing in the OpenAI API says whether a model accepts reasoning_effort,
 * so this is learned, in order of trust:
 *   1. "rejected": the server answered 400 to a request carrying an effort.
 *      The request was resent without it, and none is sent again (expires
 *      after a week, in case the server is upgraded).
 *   2. "discovered": the server said so. Ollama lists a model's
 *      capabilities, LiteLLM has supports_reasoning, OpenRouter lists each
 *      model's supported parameters (providers/reasoning-discovery.ts).
 *   3. A known reasoning family by name (o-series, GPT-5, gpt-oss, Gemini
 *      2.5+, Claude 4.6+, Grok 3 mini).
 * Kept in ~/.mercury/reasoning-caps.json.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from './config.js';
import type { ReasoningLevel } from './model-prefs.js';

export type CapsSource = 'discovered' | 'rejected';

export interface ReasoningCaps {
  levels: ReasoningLevel[];
  source: CapsSource;
  at: number;
}

const DISCOVERED_TTL_MS = 24 * 60 * 60 * 1000;
const REJECTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const VALID: readonly ReasoningLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Providers Mercury reaches over OpenAI Chat Completions (registry.ts). */
export const COMPAT_CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  'ollamaLocal', 'ollamaCloud', 'atomicChat', 'aimlapi', 'atlascloud', 'runcrate', 'cloudgpu', 'openaiCompat', 'litellm', 'lmStudio',
]);

let caps: Record<string, ReasoningCaps> | null = null;

function path(): string {
  return join(getMercuryHome(), 'reasoning-caps.json');
}

function key(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function load(): Record<string, ReasoningCaps> {
  if (caps) return caps;
  caps = Object.create(null) as Record<string, ReasoningCaps>;
  try {
    const raw = existsSync(path()) ? JSON.parse(readFileSync(path(), 'utf-8')) : {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const c = v as Partial<ReasoningCaps> | null;
        if (!c || (c.source !== 'discovered' && c.source !== 'rejected') || typeof c.at !== 'number' || !Array.isArray(c.levels)) continue;
        caps[k] = { source: c.source, at: c.at, levels: c.levels.filter((l): l is ReasoningLevel => (VALID as readonly string[]).includes(l as string)) };
      }
    }
  } catch { /* unreadable: start empty */ }
  return caps;
}

function save(): void {
  try {
    const all = load();
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    const tmp = `${path()}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf-8');
    renameSync(tmp, path());
  } catch { /* best effort: the in-memory copy still applies */ }
}

/** What is known about this model, if still fresh. */
export function cachedCaps(provider: string, model: string, now = Date.now()): ReasoningCaps | undefined {
  const c = load()[key(provider, model)];
  if (!c) return undefined;
  const ttl = c.source === 'rejected' ? REJECTED_TTL_MS : DISCOVERED_TTL_MS;
  return now - c.at > ttl ? undefined : c;
}

/** Is a fresh discovery result (or a rejection) already known? */
export function capsKnown(provider: string, model: string): boolean {
  return cachedCaps(provider, model) !== undefined;
}

export function rememberCaps(provider: string, model: string, levels: ReasoningLevel[], source: CapsSource, now = Date.now()): void {
  const all = load();
  // A server's own rejection outranks what it (or a name) suggested.
  const prior = all[key(provider, model)];
  if (source === 'discovered' && prior?.source === 'rejected' && now - prior.at <= REJECTED_TTL_MS) return;
  all[key(provider, model)] = { levels, source, at: now };
  save();
}

/** Test hook. */
export function resetReasoningCapsCache(): void {
  caps = null;
}

/**
 * Known reasoning families that take the OpenAI reasoning_effort field
 * (directly, or mapped by a gateway such as LiteLLM or OpenRouter).
 */
export function heuristicLevels(model: string): ReasoningLevel[] {
  const id = model.toLowerCase();
  if (/(^|[/:])(o[1-9])(-mini|-pro|-preview)?(\b|[-:])/.test(id) || /(^|[/:])gpt-5/.test(id) || /gpt-oss/.test(id)) return ['low', 'medium', 'high'];
  if (/gemini-(2\.5|[3-9])/.test(id)) return ['low', 'medium', 'high'];
  if (/claude-(opus|sonnet|haiku)-(4[-.][6-9]|[5-9])/.test(id) || /claude-(fable|mythos)/.test(id)) return ['low', 'medium', 'high'];
  if (/grok-3-mini/.test(id)) return ['low', 'high'];
  return [];
}
