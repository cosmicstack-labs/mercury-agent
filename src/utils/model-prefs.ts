/**
 * Per-model user preferences: a display name and a reasoning level.
 *
 * Kept in ~/.mercury/model-prefs.json rather than mercury.yaml because the
 * agent holds its own copy of the config and rewrites the whole file on
 * provider switches, which would clobber prefs saved from the dashboard.
 * Everything runs in the daemon process, so the in-memory copy here is the
 * source of truth once loaded.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from './config.js';

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface ModelPref {
  /** User-chosen display name; absent means use the generated one. */
  label?: string;
  /** Absent means "auto": send nothing and let the model decide. */
  reasoning?: ReasoningLevel;
}

const REASONING_LEVELS: readonly ReasoningLevel[] = ['off', 'low', 'medium', 'high'];
const MAX_LABEL_LENGTH = 80;
/** Same bound Agent.switchProvider applies to model ids. */
const MAX_REF_LENGTH = 256;

let prefs: Record<string, ModelPref> | null = null;

/**
 * A provider name or model id fit to key prefs: a non-empty string of at most
 * 256 characters without control characters (mirrors Agent.switchProvider).
 */
export function isValidModelRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REF_LENGTH
    && ![...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
}

/** Keep only well-formed entries and fields from a parsed prefs file. */
function sanitize(raw: unknown): Record<string, ModelPref> {
  const clean: Record<string, ModelPref> = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  for (const [entryKey, value] of Object.entries(raw)) {
    const sep = entryKey.indexOf('::');
    if (sep <= 0 || !isValidModelRef(entryKey.slice(0, sep)) || !isValidModelRef(entryKey.slice(sep + 2))) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { label, reasoning } = value as Record<string, unknown>;
    const pref: ModelPref = {};
    if (typeof label === 'string' && label.trim()) pref.label = label.trim().slice(0, MAX_LABEL_LENGTH);
    if (isReasoningLevel(reasoning)) pref.reasoning = reasoning;
    if (pref.label !== undefined || pref.reasoning !== undefined) clean[entryKey] = pref;
  }
  return clean;
}

function prefsPath(): string {
  return join(getMercuryHome(), 'model-prefs.json');
}

function key(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function load(): Record<string, ModelPref> {
  if (prefs) return prefs;
  try {
    const path = prefsPath();
    // Hand edits must not reach the wire or the UI unchecked.
    prefs = sanitize(existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {});
  } catch {
    prefs = Object.create(null) as Record<string, ModelPref>;
  }
  return prefs;
}

function save(): void {
  const path = prefsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf-8');
  renameSync(tmp, path);
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

export function getModelPref(provider: string, model: string): ModelPref {
  return load()[key(provider, model)] ?? {};
}

/**
 * Update a model's prefs. `null` (or an empty label / 'auto') clears a field;
 * `undefined` leaves it unchanged.
 */
export function setModelPref(
  provider: string,
  model: string,
  update: { label?: string | null; reasoning?: ReasoningLevel | 'auto' | null },
): ModelPref {
  const all = load();
  const next: ModelPref = { ...all[key(provider, model)] };

  if (update.label !== undefined) {
    const label = update.label?.trim().slice(0, MAX_LABEL_LENGTH);
    if (label) next.label = label;
    else delete next.label;
  }
  if (update.reasoning !== undefined) {
    if (isReasoningLevel(update.reasoning)) next.reasoning = update.reasoning;
    else delete next.reasoning;
  }

  if (next.label === undefined && next.reasoning === undefined) delete all[key(provider, model)];
  else all[key(provider, model)] = next;
  save();
  return next;
}

/** Test hook: forget the in-memory copy so the next read hits disk. */
export function resetModelPrefsCache(): void {
  prefs = null;
}

// ─── Reasoning ───────────────────────────────────────────────────────────────

/** OpenAI API models that accept a reasoning effort: o-series and GPT-5 family. */
const OPENAI_REASONING_MODEL = /^(o\d|gpt-5)/i;

/** Providers with any reasoning control (decides whether to hook requests at all). */
export function providerHasReasoningControl(provider: string): boolean {
  return ['chatgptWeb', 'openai', 'ollamaLocal', 'ollamaCloud'].includes(provider);
}

/**
 * Levels a model can honour. ChatGPT/OpenAI models may reject "none", so they
 * get no Off; Ollama maps Off to reasoning_effort "none" (thinking off). On
 * the OpenAI API only reasoning models accept an effort at all: gpt-4o or
 * gpt-4.1 would answer 400 "Unsupported parameter". Anything else: none.
 */
export function reasoningLevelsFor(provider: string, model?: string): ReasoningLevel[] {
  if (provider === 'chatgptWeb') return ['low', 'medium', 'high'];
  if (provider === 'openai') return model && OPENAI_REASONING_MODEL.test(model) ? ['low', 'medium', 'high'] : [];
  if (provider === 'ollamaLocal' || provider === 'ollamaCloud') return ['off', 'low', 'medium', 'high'];
  return [];
}

/** The saved level for a model, only if that model can still honour it. */
export function effectiveReasoning(provider: string, model: string): ReasoningLevel | undefined {
  const level = getModelPref(provider, model).reasoning;
  return level && reasoningLevelsFor(provider, model).includes(level) ? level : undefined;
}

/**
 * Apply a reasoning level to an outgoing OpenAI-style request body, in place.
 * Done at the HTTP layer because the AI SDK drops reasoningEffort for model
 * ids it doesn't recognise as reasoning models (anything not o1/o3/o4/gpt-5*).
 */
export function applyReasoningToBody(body: Record<string, unknown>, level: ReasoningLevel | undefined): void {
  if (!level) return;
  if (Array.isArray(body.input)) {
    // Responses API
    const reasoning = (body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {}) as Record<string, unknown>;
    body.reasoning = { ...reasoning, effort: level === 'off' ? 'none' : level };
  } else if (Array.isArray(body.messages)) {
    // Chat Completions (Ollama's /v1 maps "none" to thinking off)
    body.reasoning_effort = level === 'off' ? 'none' : level;
  }
}

// ─── Display names ───────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  chatgptWeb: 'ChatGPT',
  openai: 'OpenAI API',
  anthropic: 'Claude (API)',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  ollamaLocal: 'Ollama · this PC',
  ollamaCloud: 'Ollama Cloud',
  lmStudio: 'LM Studio',
  atomicChat: 'Atomic Chat',
  openaiCompat: 'OpenAI-compatible',
  openrouter: 'OpenRouter',
  litellm: 'LiteLLM',
  aimlapi: 'AI/ML API',
  atlascloud: 'Atlas Cloud',
  mimo: 'MiMo',
  mimoTokenPlan: 'MiMo Token Plan',
  githubCopilot: 'GitHub Copilot',
  mercuryCloud: 'Mercury Cloud',
};

/** True for Ollama models that run on ollama.com but are served through the local daemon. */
export function isOllamaCloudModel(model: string): boolean {
  return /(^|[:-])cloud$/i.test(model);
}

/** The heading a model is grouped under in pickers. */
export function modelGroupLabel(provider: string, model: string): string {
  if (provider === 'ollamaLocal' && isOllamaCloudModel(model)) return 'Ollama Cloud · via this PC';
  return PROVIDER_LABELS[provider] ?? provider;
}

const WORD_CASE: Record<string, string> = {
  gpt: 'GPT', oss: 'OSS', glm: 'GLM', qwen: 'Qwen', gemma: 'Gemma', kimi: 'Kimi',
  deepseek: 'DeepSeek', mistral: 'Mistral', minimax: 'MiniMax', nemotron: 'Nemotron',
  llama: 'Llama', phi: 'Phi', nsfw: 'NSFW', ai: 'AI', vl: 'VL', moe: 'MoE', it: 'IT',
  qwopus: 'Qwopus', ablit: 'Abliterated', abliterated: 'Abliterated', huihui: 'Huihui',
};

const QUANT_RE = /^(i?q\d[a-z0-9_]*|f16|fp16|bf16|fp8|int8|int4|nvfp4|mxfp4|awq|gptq)$/i;

function titleWord(word: string): string {
  const lower = word.toLowerCase();
  if (WORD_CASE[lower]) return WORD_CASE[lower];
  // Sizes and versions: 27b → 27B, 120b → 120B, a3b → A3B, v4.1 → V4.1, k2.7 → K2.7
  if (/^\d+(\.\d+)?[bmk]$/i.test(word)) return word.toUpperCase();
  if (/^[a-z]\d+(\.\d+)?[a-z]?$/i.test(word)) return word.toUpperCase();
  if (/^\d/.test(word)) return word;
  // A brand fused with a version: qwen3.8 → Qwen 3.8, gemma4 → Gemma 4
  const fused = /^([a-z]+?)(\d+(?:\.\d+)*)$/i.exec(word);
  if (fused && WORD_CASE[fused[1].toLowerCase()]) return `${WORD_CASE[fused[1].toLowerCase()]} ${fused[2]}`;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Turn a raw model id into something readable, e.g.
 *   qwen3.8:27b-nvfp4-5090   → Qwen 3.8 27B (NVFP4 · 5090)
 *   gpt-6-sol                → GPT-6 Sol
 *   hf.co/user/Foo-27B-GGUF:Q4_K_M → Foo 27B (Q4_K_M)
 */
export function humanizeModelName(model: string): string {
  let id = model.trim();
  if (!id) return model;
  id = id.replace(/^hf\.co\/[^/]+\//i, '');
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);

  const [rawName, rawTag = ''] = id.split(':', 2);
  const name = rawName.replace(/[-_.]gguf$/i, '');
  const nameWords: string[] = [];
  const extras: string[] = [];

  // Hyphens separate words; underscores belong to quant tags like Q4_K_M.
  const parts = name.split(/[-\s]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Keep GPT-style "GPT-6" / "GPT-5.6" joined.
    if (/^gpt$/i.test(part) && parts[i + 1] && /^\d/.test(parts[i + 1])) {
      nameWords.push(`GPT-${parts[++i]}`);
    } else if (QUANT_RE.test(part)) {
      extras.push(part.toUpperCase());
    } else {
      nameWords.push(titleWord(part));
    }
  }

  for (const part of rawTag.split(/-+/).filter(Boolean)) {
    if (/^(latest|cloud)$/i.test(part)) continue;
    if (QUANT_RE.test(part)) extras.push(part.toUpperCase());
    else if (/^\d+(\.\d+)?[bmk]$/i.test(part)) nameWords.push(part.toUpperCase());
    else if (/^\d{4}$/.test(part)) extras.push(part);
    else nameWords.push(titleWord(part));
  }

  const base = nameWords.join(' ').replace(/\s+/g, ' ').trim() || model;
  const tags = [...new Set(extras)];
  return tags.length ? `${base} (${tags.join(' · ')})` : base;
}

/** The name to show for a model: the user's label, else the generated one. */
export function displayModelName(provider: string, model: string): string {
  return getModelPref(provider, model).label ?? humanizeModelName(model);
}
