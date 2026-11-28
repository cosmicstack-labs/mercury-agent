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
import { ScopedValue } from './turn-scope.js';
import { cachedCaps, heuristicLevels } from './reasoning-caps.js';

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelPref {
  /** User-chosen display name; absent means use the generated one. */
  label?: string;
  /** Absent means "auto": send nothing and let the model decide. */
  reasoning?: ReasoningLevel;
}

const REASONING_LEVELS: readonly ReasoningLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
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

/** Providers with their own request path (no OpenAI-style effort field from here). */
const OWN_WIRE = new Set(['anthropic', 'deepseek', 'mercuryCloud', 'mimo', 'mimoTokenPlan', 'githubCopilot']);

/**
 * Providers whose requests go through the OpenAI-style hook (decides whether
 * to hook requests at all; the hook changes a body only when the model has
 * levels and one is chosen).
 */
export function providerHasReasoningControl(provider: string): boolean {
  return !OWN_WIRE.has(provider);
}

/**
 * What a Claude model does with thinking, from its id (any prefix or date
 * suffix: "claude-opus-5-5", "anthropic/claude-sonnet-4-6-2026…").
 *
 * - thinksByDefault: Claude 5-era models (Opus/Sonnet/Haiku 5+, Fable,
 *   Mythos) run adaptive thinking whether or not it is asked for, and some
 *   reject turning it off. Their thinking text is "omitted" unless the
 *   request asks for a summary.
 * - adaptive: accepts thinking {type: "adaptive"} (4.6 and later). Older
 *   models (4.5, 3.x) only take a token budget, which Mercury does not send.
 * - levels: output_config.effort values the model accepts. "xhigh" arrived
 *   with Opus 4.7; 4.6 has low…high plus max.
 */
export interface ClaudeThinking {
  thinksByDefault: boolean;
  adaptive: boolean;
  levels: ReasoningLevel[];
}

const NO_CLAUDE_THINKING: ClaudeThinking = { thinksByDefault: false, adaptive: false, levels: [] };

export function claudeThinking(model: string): ClaudeThinking {
  const id = model.toLowerCase();
  if (/claude-(fable|mythos)\b/.test(id)) {
    return { thinksByDefault: true, adaptive: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  }
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d)(?!\d))?/.exec(id);
  if (!m) return NO_CLAUDE_THINKING;
  const family = m[1];
  const version = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  if (version >= 5) return { thinksByDefault: true, adaptive: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  if (version >= 4.7 && family === 'opus') return { thinksByDefault: false, adaptive: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  if (version >= 4.6 && family !== 'haiku') return { thinksByDefault: false, adaptive: true, levels: ['low', 'medium', 'high', 'max'] };
  return NO_CLAUDE_THINKING;
}

/**
 * Levels a model can honour. ChatGPT/OpenAI models may reject "none", so they
 * get no Off; Ollama maps Off to reasoning_effort "none" (thinking off). On
 * the OpenAI API only reasoning models accept an effort at all: gpt-4o or
 * gpt-4.1 would answer 400 "Unsupported parameter". Claude gets the efforts
 * its model accepts and no Off (Opus 5.5 rejects disabling thinking; on
 * older models "not set" already means no thinking). Anything else: none.
 */
export function reasoningLevelsFor(provider: string, model?: string): ReasoningLevel[] {
  if (provider === 'chatgptWeb') return ['low', 'medium', 'high'];
  if (provider === 'anthropic') return model ? claudeThinking(model).levels : [];
  if (OWN_WIRE.has(provider)) return [];
  const ollama = provider === 'ollamaLocal' || provider === 'ollamaCloud';
  if (!model) return ollama ? ['off', 'low', 'medium', 'high'] : [];
  // What the server said (or a 400 it answered) beats any guess (reasoning-caps.ts).
  const known = cachedCaps(provider, model);
  if (known) return known.levels;
  if (provider === 'openai') return OPENAI_REASONING_MODEL.test(model) ? ['low', 'medium', 'high'] : [];
  // Until Ollama has been asked: its own levels for gpt-oss, on/off for the rest.
  if (ollama) return /gpt-oss/i.test(model) ? ['low', 'medium', 'high'] : ['off', 'low', 'medium', 'high'];
  return heuristicLevels(model);
}

/** How a level reads on screen: "auto" → "Auto", "xhigh" → "Extra high". */
export function effortLabel(level: string): string {
  return ({ auto: 'Auto', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' } as Record<string, string>)[level] ?? level;
}

// ─── Per-chat effort (issue #188) ────────────────────────────────────────────

/**
 * A chat can override its model's effort ("/effort high" in that chat, the
 * desktop's Effort picker). The running turn names its chat here, so every
 * request it makes reads that chat's override. Kept in
 * ~/.mercury/chat-effort.json, keyed by the chat (the turn's lane: a
 * desktop thread id, "cli", or a channel conversation).
 */
const effortChat = new ScopedValue<string | undefined>(undefined);
const MAX_CHAT_OVERRIDES = 1000;
let chatEfforts: Record<string, ReasoningLevel | 'auto'> | null = null;

function chatEffortPath(): string {
  return join(getMercuryHome(), 'chat-effort.json');
}

function loadChatEfforts(): Record<string, ReasoningLevel | 'auto'> {
  if (chatEfforts) return chatEfforts;
  chatEfforts = Object.create(null) as Record<string, ReasoningLevel | 'auto'>;
  try {
    const raw = existsSync(chatEffortPath()) ? JSON.parse(readFileSync(chatEffortPath(), 'utf-8')) : {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (isValidModelRef(k) && (v === 'auto' || isReasoningLevel(v))) chatEfforts[k] = v;
      }
    }
  } catch { /* unreadable: no overrides */ }
  return chatEfforts;
}

/** The running turn's chat: its requests read this chat's override. */
export function claimEffortChat(chatKey: string): void {
  effortChat.claim(chatKey);
}

export function currentEffortChat(): string | undefined {
  return effortChat.get();
}

export function getChatEffort(chatKey: string): ReasoningLevel | 'auto' | undefined {
  return loadChatEfforts()[chatKey];
}

/** Set a chat's override; null clears it (back to the model's default). */
export function setChatEffort(chatKey: string, level: ReasoningLevel | 'auto' | null): void {
  if (!isValidModelRef(chatKey)) return;
  const all = loadChatEfforts();
  delete all[chatKey];
  if (level) all[chatKey] = level;
  const keys = Object.keys(all);
  if (keys.length > MAX_CHAT_OVERRIDES) for (const k of keys.slice(0, keys.length - MAX_CHAT_OVERRIDES)) delete all[k];
  const tmp = `${chatEffortPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
  renameSync(tmp, chatEffortPath());
}

export interface EffortState {
  /** What requests carry: undefined = nothing (the model decides). */
  effective: ReasoningLevel | undefined;
  /** Where it comes from: this chat's override, the model's default, or neither. */
  source: 'chat' | 'model' | 'auto';
  /** The model's saved default ("auto" when none). */
  modelDefault: ReasoningLevel | 'auto';
  /** This chat's override, if any. */
  chat?: ReasoningLevel | 'auto';
  /** The chat asked for a level this model doesn't take: the model's default applies. */
  chatUnsupported?: boolean;
  levels: ReasoningLevel[];
}

/** The effort a request for this model carries in this chat, and why. */
export function effortFor(provider: string, model: string, chatKey: string | undefined = effortChat.get()): EffortState {
  const levels = reasoningLevelsFor(provider, model);
  const saved = getModelPref(provider, model).reasoning;
  const modelDefault = saved && levels.includes(saved) ? saved : undefined;
  const chat = chatKey ? getChatEffort(chatKey) : undefined;
  const base = { modelDefault: modelDefault ?? ('auto' as const), levels, ...(chat ? { chat } : {}) };
  if (chat === 'auto' && levels.length) return { ...base, effective: undefined, source: 'chat' };
  if (chat && chat !== 'auto') {
    if (levels.includes(chat)) return { ...base, effective: chat, source: 'chat' };
    if (levels.length) return { ...base, effective: modelDefault, source: modelDefault ? 'model' : 'auto', chatUnsupported: true };
  }
  return { ...base, effective: modelDefault, source: modelDefault ? 'model' : 'auto' };
}

/** The level a request for this model carries (the running chat's override, else the model's default). */
export function effectiveReasoning(provider: string, model: string): ReasoningLevel | undefined {
  return effortFor(provider, model).effective;
}

/** Test hook. */
export function resetChatEffortCache(): void {
  chatEfforts = null;
}

/** Is this an OpenRouter endpoint (its effort goes in `reasoning: {effort}`)? */
export function isOpenRouterUrl(baseUrl: string | undefined): boolean {
  return !!baseUrl && /(^|\/\/|\.)openrouter\.ai(\/|:|$)/i.test(baseUrl);
}

/**
 * Anthropic provider options for one request: show the thinking (as the
 * API's summary) wherever the model thinks, and apply the chosen effort.
 *
 * - Models that think by default always get display "summarized": the
 *   thinking happens and is billed either way; without it the stream carries
 *   empty thinking blocks and the screen shows a long silent pause.
 * - Models where thinking is opt-in (4.6–4.8) think only when the owner
 *   picked an effort; "Auto" leaves the request exactly as before.
 */
export function anthropicThinkingOptions(model: string, level: ReasoningLevel | undefined): Record<string, unknown> | undefined {
  const caps = claudeThinking(model);
  if (!caps.adaptive) return undefined;
  const effort = level && caps.levels.includes(level) ? level : undefined;
  if (!caps.thinksByDefault && !effort) return undefined;
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(effort ? { effort } : {}),
  };
}

/**
 * Apply a reasoning level to an outgoing OpenAI-style request body, in place.
 * Done at the HTTP layer because the AI SDK drops reasoningEffort for model
 * ids it doesn't recognise as reasoning models (anything not o1/o3/o4/gpt-5*).
 */
export function applyReasoningToBody(
  body: Record<string, unknown>,
  level: ReasoningLevel | undefined,
  { summary = false, openRouter = false }: { summary?: boolean; openRouter?: boolean } = {},
): void {
  if (Array.isArray(body.input)) {
    // Responses API. A summary of the reasoning, where asked for, is what a
    // screen can show while the model thinks (the raw reasoning never is).
    if (!level && !summary) return;
    const reasoning = (body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {}) as Record<string, unknown>;
    body.reasoning = {
      ...reasoning,
      ...(level ? { effort: level === 'off' ? 'none' : level } : {}),
      ...(summary && level !== 'off' && reasoning.summary === undefined ? { summary: 'auto' } : {}),
    };
  } else if (level && Array.isArray(body.messages)) {
    if (openRouter) {
      // OpenRouter's unified field, mapped to each upstream's own control.
      const reasoning = (body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {}) as Record<string, unknown>;
      body.reasoning = { ...reasoning, effort: level === 'off' ? 'none' : level };
    } else {
      // Chat Completions (Ollama's /v1 maps "none" to thinking off)
      body.reasoning_effort = level === 'off' ? 'none' : level;
    }
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
  runcrate: 'Runcrate',
  cloudgpu: 'CloudGPU',
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
  // A dated snapshot ("…-20251001") reads as the model; a version split into
  // numbers ("haiku-4-5", "llama-3-1-8b") reads as one: 4.5, 3.1.
  const raw = name.split(/[-\s]+/).filter(Boolean).filter((p, i, all) => !(i > 0 && /^(19|20)\d{6}$/.test(p) && all.length > 1));
  const parts: string[] = [];
  for (const p of raw) {
    const prev = parts[parts.length - 1];
    if (/^\d{1,2}$/.test(p) && prev && /^\d{1,2}$/.test(prev) && parts.length >= 2 && !/^\d/.test(parts[parts.length - 2])) parts[parts.length - 1] = `${prev}.${p}`;
    else parts.push(p);
  }
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
