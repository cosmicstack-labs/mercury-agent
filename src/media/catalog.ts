/**
 * Which of the owner's configured providers can make images, and with which
 * models (ADR-042). Model ids change too fast to hard-code (Sora's API and
 * Imagen were retired in 2026), so they are discovered from each provider:
 *
 *   OpenRouter     /api/v1/models?output_modalities=image   (generated via chat, modalities)
 *   LiteLLM        /model/info  model_info.mode == "image_generation"
 *   any /models    output_modalities ∋ "image" (Runcrate, Atlas Cloud, Mercury Cloud),
 *                  type ∋ "image" (AI/ML API), or a known image-model name
 *                  (gpt-image-*, dall-e-*, flux*, imagen*, seedream*, …)
 *   Ollama         /api/tags names of its (experimental) image models
 *
 * Everything but OpenRouter is called through the OpenAI Images API
 * (/images/generations, /images/edits), which those servers expose.
 * Cached for a day in ~/.mercury/media-models.json; a failed provider keeps
 * what was known about it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { isOpenRouterUrl } from '../utils/model-prefs.js';
import { humanizeModelName, modelGroupLabel } from '../utils/model-prefs.js';
import { logger } from '../utils/logger.js';
import type { MediaEndpoint } from '../providers/base.js';

export type MediaKind = 'image' | 'speech' | 'video' | 'music';

/** How a model is called: the OpenAI Images API, or OpenRouter's chat with image output. */
/**
 * How a model is called: the OpenAI Images / Videos / Speech APIs,
 * OpenRouter's chat with image output, Gemini (generateContent for images,
 * the Interactions API for Omni video and Lyria music), or ElevenLabs Music.
 */
export type ImageBackend = 'openai-images' | 'openrouter-chat' | 'openai-speech' | 'openai-videos' | 'gemini-image' | 'gemini-omni' | 'gemini-lyria' | 'elevenlabs-music';

/** Sources that aren't chat providers: keys saved for voice (Settings → Voice). */
export const GEMINI_SOURCE = 'gemini';
export const ELEVENLABS_SOURCE = 'elevenlabs';

export interface MediaModel {
  /** "provider::model" — what settings and /media store. */
  ref: string;
  provider: string;
  model: string;
  kind: MediaKind;
  backend: ImageBackend;
  label: string;
  group: string;
  /** Takes reference images (edits). */
  canEdit: boolean;
}

/** A configured provider Mercury can ask about media models. */
export interface MediaSource {
  name: string;
  /** The provider's chat base URL (decides OpenRouter / Ollama handling). */
  baseUrl: string;
  endpoint(): Promise<MediaEndpoint | undefined>;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

/** Image models by name, for servers whose model list says nothing more. */
export const IMAGE_MODEL_NAME = /(^|[/:._-])(gpt-image|chatgpt-image|dall-e|dalle|flux|imagen|seedream|seededit|stable-diffusion|sdxl|sd3|sd-?3\.5|hidream|recraft|ideogram|qwen-image|z-image|nano-banana|playground-v|kandinsky|grok-(2-)?image|grok-imagine-image|cogview|hunyuan-image|wan.*-t2i|gemini-[\w.-]*-image)/i;
/** Names that look like image models but generate something else (or only read images). */
const NOT_IMAGE_OUTPUT = /(vision|-vl\b|embedding|caption|ocr|upscal|video|t2v|i2v|tts|audio)/i;

export function refOf(provider: string, model: string): string {
  return `${provider}::${model}`;
}

export function parseRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf('::');
  if (i <= 0 || i === ref.length - 2) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 2) };
}

function model(provider: string, id: string, backend: ImageBackend): MediaModel {
  const editable = backend === 'openrouter-chat'
    || /gpt-image|chatgpt-image|dall-e-2|flux.*(kontext|edit|fill)|seededit|qwen-image-edit|nano-banana|gemini-[\w.-]*-image/i.test(id);
  return {
    ref: refOf(provider, id),
    provider,
    model: id,
    kind: 'image',
    backend,
    label: /dall-e-?(\d)/i.test(id) ? `DALL·E ${/dall-e-?(\d)/i.exec(id)![1]}` : humanizeModelName(id),
    group: modelGroupLabel(provider, id),
    canEdit: editable,
  };
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface ListedModel {
  id?: string;
  type?: string;
  output_modalities?: unknown;
  architecture?: { output_modalities?: unknown };
}

/** Is a /models entry an image generator? */
export function isImageModelEntry(m: ListedModel): boolean {
  const id = typeof m.id === 'string' ? m.id : '';
  if (!id) return false;
  const outputs = Array.isArray(m.output_modalities) ? m.output_modalities
    : Array.isArray(m.architecture?.output_modalities) ? m.architecture!.output_modalities as unknown[]
    : undefined;
  if (outputs) return outputs.includes('image');
  if (typeof m.type === 'string') return /image-generation|images?\/generations|text-to-image|image_generation/i.test(m.type);
  return IMAGE_MODEL_NAME.test(id) && !NOT_IMAGE_OUTPUT.test(id);
}

/** The image models one provider offers; undefined when it couldn't be asked. */
export async function listImageModels(src: MediaSource, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaModel[] | undefined> {
  if (src.name === ELEVENLABS_SOURCE) return [];
  if (src.name === GEMINI_SOURCE) return (await listGeminiModels(src, fetchImpl))?.filter((m) => m.kind === 'image');
  const ep = await src.endpoint().catch(() => undefined);
  if (!ep) return undefined;
  if (isOpenRouterUrl(src.baseUrl)) {
    const list = await getJson('https://openrouter.ai/api/v1/models?output_modalities=image', ep.headers, fetchImpl) as { data?: ListedModel[] } | undefined;
    if (!list?.data) return undefined;
    return list.data.filter((m) => typeof m.id === 'string' && isImageModelEntry(m)).map((m) => model(src.name, m.id!, 'openrouter-chat'));
  }
  if (src.name === 'litellm') {
    const root = ep.baseUrl.replace(/\/v1$/i, '');
    const info = await getJson(`${root}/model/info`, ep.headers, fetchImpl) as { data?: Array<{ model_name?: string; model_info?: { mode?: string } }> } | undefined;
    if (info?.data) {
      return [...new Set(info.data.filter((m) => m.model_info?.mode === 'image_generation' && m.model_name).map((m) => m.model_name!))]
        .map((id) => model(src.name, id, 'openai-images'));
    }
  }
  if (src.name === 'ollamaLocal' || src.name === 'ollamaCloud') {
    const root = ep.baseUrl.replace(/\/v1$/i, '');
    const tags = await getJson(`${root}/api/tags`, ep.headers, fetchImpl) as { models?: Array<{ name?: string }> } | undefined;
    if (!tags?.models) return undefined;
    return tags.models.map((m) => m.name ?? '').filter((n) => n && IMAGE_MODEL_NAME.test(n) && !NOT_IMAGE_OUTPUT.test(n)).map((n) => model(src.name, n, 'openai-images'));
  }
  const list = await getJson(`${ep.baseUrl}/models`, ep.headers, fetchImpl) as { data?: ListedModel[] } | undefined;
  if (!list?.data) return undefined;
  return withoutSnapshots(list.data.filter(isImageModelEntry).map((m) => model(src.name, m.id!, 'openai-images')));
}

/** Speech (text-to-speech) models by name, for servers whose model list says nothing more. */
export const SPEECH_MODEL_NAME = /(^|[/:._-])(tts|[\w.-]*-tts([\w.-]*)?|speech-\d|kokoro|orpheus|sesame|chatterbox|xtts|eleven[\w-]*|aura-[\w-]+)($|[/:._-])/i;
const NOT_SPEECH = /(transcri|whisper|stt|asr|realtime|audio-preview)/i;

/** Is a /models entry a text-to-speech model (served at /audio/speech)? */
export function isSpeechModelEntry(m: ListedModel): boolean {
  const id = typeof m.id === 'string' ? m.id : '';
  if (!id || NOT_SPEECH.test(id)) return false;
  const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : undefined;
  if (outputs?.includes('speech')) return true;
  if (typeof m.type === 'string' && /text-to-speech|audio\/speech|audio_speech/i.test(m.type)) return true;
  return SPEECH_MODEL_NAME.test(id);
}

function speechModel(provider: string, id: string): MediaModel {
  return { ref: refOf(provider, id), provider, model: id, kind: 'speech', backend: 'openai-speech', label: humanizeModelName(id), group: modelGroupLabel(provider, id), canEdit: false };
}

/** The speech models one provider offers through /audio/speech; undefined when it couldn't be asked. */
export async function listSpeechModels(src: MediaSource, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaModel[] | undefined> {
  // Gemini and ElevenLabs speak as direct services (speech.ts), not as listed models.
  if (isOpenRouterUrl(src.baseUrl) || src.name === 'ollamaLocal' || src.name === 'ollamaCloud' || src.name === GEMINI_SOURCE || src.name === ELEVENLABS_SOURCE) return [];
  const ep = await src.endpoint().catch(() => undefined);
  if (!ep) return undefined;
  if (src.name === 'litellm') {
    const root = ep.baseUrl.replace(/\/v1$/i, '');
    const info = await getJson(`${root}/model/info`, ep.headers, fetchImpl) as { data?: Array<{ model_name?: string; model_info?: { mode?: string } }> } | undefined;
    if (info?.data) {
      return [...new Set(info.data.filter((m) => m.model_info?.mode === 'audio_speech' && m.model_name).map((m) => m.model_name!))].map((id) => speechModel(src.name, id));
    }
  }
  const list = await getJson(`${ep.baseUrl}/models`, ep.headers, fetchImpl) as { data?: ListedModel[] } | undefined;
  if (!list?.data) return undefined;
  return withoutSnapshots(list.data.filter(isSpeechModelEntry).map((m) => speechModel(src.name, m.id!)));
}

/* ── Gemini (a key saved for voice), video and music ── */

function mediaModel(provider: string, id: string, kind: MediaKind, backend: ImageBackend, label?: string, canEdit = false): MediaModel {
  return { ref: refOf(provider, id), provider, model: id, kind, backend, label: label ?? humanizeModelName(id), group: provider === GEMINI_SOURCE ? 'Gemini' : provider === ELEVENLABS_SOURCE ? 'ElevenLabs' : modelGroupLabel(provider, id), canEdit };
}

/**
 * What a Gemini key offers: image models (generateContent with image
 * output), Omni video and Lyria music (Interactions API). Lyria RealTime
 * (a live stream, bidiGenerateMusic) is not a file and is left out.
 */
export async function listGeminiModels(src: MediaSource, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaModel[] | undefined> {
  const ep = await src.endpoint().catch(() => undefined);
  if (!ep) return undefined;
  const list = await getJson(`${ep.baseUrl}/models?pageSize=1000`, ep.headers, fetchImpl) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> } | undefined;
  if (!list?.models) return undefined;
  const out: MediaModel[] = [];
  for (const m of list.models) {
    const id = (m.name ?? '').replace(/^models\//, '');
    const methods = m.supportedGenerationMethods ?? [];
    if (!id || !methods.includes('generateContent')) continue;
    if (/-image(\b|-|$)/.test(id)) out.push(mediaModel(GEMINI_SOURCE, id, 'image', 'gemini-image', m.displayName, true));
    else if (/omni/.test(id)) out.push(mediaModel(GEMINI_SOURCE, id, 'video', 'gemini-omni', m.displayName, true));
    else if (/lyria/.test(id)) out.push(mediaModel(GEMINI_SOURCE, id, 'music', 'gemini-lyria', m.displayName));
  }
  return out;
}

/** ElevenLabs Music: the models its API takes (it has no listing for them). */
export const ELEVENLABS_MUSIC_MODELS: Array<{ id: string; label: string }> = [
  { id: 'music_v2_5', label: 'Eleven Music v2.5' },
  { id: 'music_v2', label: 'Eleven Music v2' },
  { id: 'music_v1', label: 'Eleven Music v1' },
];

/** Video models by name, for servers whose model list says nothing more. */
export const VIDEO_MODEL_NAME = /(^|[/:._-])(sora|veo|kling|hailuo|seedance|runway|gen-?4|luma|ray-?\d|ltx-?video|ltxv|hunyuan-?video|pika|mochi|vidu|wan[\w.-]*-(t2v|i2v)|minimax-video|cogvideo|grok-imagine-video)/i;

/** Video models one provider offers through the OpenAI Videos API (/videos). */
export async function listVideoModels(src: MediaSource, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaModel[] | undefined> {
  if (src.name === GEMINI_SOURCE) return (await listGeminiModels(src, fetchImpl))?.filter((m) => m.kind === 'video');
  if (src.name === ELEVENLABS_SOURCE || isOpenRouterUrl(src.baseUrl) || src.name === 'ollamaLocal' || src.name === 'ollamaCloud') return [];
  const ep = await src.endpoint().catch(() => undefined);
  if (!ep) return undefined;
  if (src.name === 'litellm') {
    const root = ep.baseUrl.replace(/\/v1$/i, '');
    const info = await getJson(`${root}/model/info`, ep.headers, fetchImpl) as { data?: Array<{ model_name?: string; model_info?: { mode?: string } }> } | undefined;
    if (info?.data) {
      return [...new Set(info.data.filter((m) => m.model_info?.mode === 'video_generation' && m.model_name).map((m) => m.model_name!))].map((id) => mediaModel(src.name, id, 'video', 'openai-videos', undefined, true));
    }
  }
  const list = await getJson(`${ep.baseUrl}/models`, ep.headers, fetchImpl) as { data?: ListedModel[] } | undefined;
  if (!list?.data) return undefined;
  return withoutSnapshots(list.data.filter((m) => {
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id) return false;
    const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : undefined;
    if (outputs) return outputs.includes('video');
    if (typeof m.type === 'string') return /video-generation|videos\/generations|text-to-video/i.test(m.type);
    return VIDEO_MODEL_NAME.test(id);
  }).map((m) => mediaModel(src.name, m.id!, 'video', 'openai-videos', undefined, true)));
}

/** Music: Gemini Lyria and ElevenLabs Music (no OpenAI-style music API exists). */
export async function listMusicModels(src: MediaSource, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaModel[] | undefined> {
  if (src.name === GEMINI_SOURCE) return (await listGeminiModels(src, fetchImpl))?.filter((m) => m.kind === 'music');
  if (src.name === ELEVENLABS_SOURCE) return ELEVENLABS_MUSIC_MODELS.map((m) => mediaModel(ELEVENLABS_SOURCE, m.id, 'music', 'elevenlabs-music', m.label));
  return [];
}

/** Drop dated snapshots ("gpt-image-2-2026-04-21", "tts-1-1106") when the plain name is offered too. */
export function withoutSnapshots(models: MediaModel[]): MediaModel[] {
  const ids = new Set(models.map((m) => `${m.provider}::${m.model}`));
  return models.filter((m) => {
    const base = m.model.replace(/-(\d{4}-\d{2}-\d{2}|\d{4})$/, '');
    return base === m.model || !ids.has(`${m.provider}::${base}`);
  });
}

/* ── cache ── */

interface CacheEntry { at: number; models: MediaModel[] }
let cache: Record<string, CacheEntry> | null = null;

function cachePath(): string {
  return join(getMercuryHome(), 'media-models.json');
}

function loadCache(): Record<string, CacheEntry> {
  if (cache) return cache;
  cache = {};
  try {
    const raw = existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), 'utf-8')) : {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, CacheEntry>)) {
        if (v && typeof v.at === 'number' && Array.isArray(v.models)) cache[k] = { at: v.at, models: v.models.filter((m) => m && typeof m.ref === 'string' && ['image', 'speech', 'video', 'music'].includes(m.kind)) };
      }
    }
  } catch { /* start empty */ }
  return cache;
}

function saveCache(): void {
  try {
    const tmp = `${cachePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(loadCache(), null, 2), 'utf-8');
    renameSync(tmp, cachePath());
  } catch { /* best effort */ }
}

/** Test hook. */
export function resetMediaCatalogCache(): void {
  cache = null;
}

/**
 * Models of a kind across the configured providers, in their order.
 * Providers are asked again after a day (or with `refresh`); one that can't
 * be reached keeps its last answer.
 */
async function discover(kind: MediaKind, sources: MediaSource[], lister: (src: MediaSource, f?: typeof fetch) => Promise<MediaModel[] | undefined>, opts: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number }): Promise<MediaModel[]> {
  const now = opts.now ?? Date.now();
  const all = loadCache();
  const keyOf = (src: Pick<MediaSource, 'name' | 'baseUrl'>) => `${kind === 'image' ? '' : `${kind}|`}${src.name}|${src.baseUrl}`;
  await Promise.all(sources.map(async (src) => {
    const known = all[keyOf(src)];
    if (known && !opts.refresh && now - known.at < TTL_MS) return;
    const found = await lister(src, opts.fetchImpl).catch((err) => {
      logger.debug({ provider: src.name, kind, err: err instanceof Error ? err.message : String(err) }, 'Media model discovery failed');
      return undefined;
    });
    if (found) all[keyOf(src)] = { at: now, models: found };
  }));
  saveCache();
  return sources.flatMap((src) => all[keyOf(src)]?.models ?? []);
}

/** Image models across the configured providers. */
export function imageModels(sources: MediaSource[], opts: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<MediaModel[]> {
  return discover('image', sources, listImageModels, opts);
}

/** Text-to-speech models across the configured providers. */
export function speechModels(sources: MediaSource[], opts: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<MediaModel[]> {
  return discover('speech', sources, listSpeechModels, opts);
}

/** Video models across the configured providers (and a Gemini key). */
export function videoModels(sources: MediaSource[], opts: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<MediaModel[]> {
  return discover('video', sources, listVideoModels, opts);
}

/** Music models: Gemini Lyria, ElevenLabs Music. */
export function musicModels(sources: MediaSource[], opts: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<MediaModel[]> {
  return discover('music', sources, listMusicModels, opts);
}

/** What is known without asking anyone (for synchronous callers). */
export function knownImageModels(sources: Array<Pick<MediaSource, 'name' | 'baseUrl'>>): MediaModel[] {
  const all = loadCache();
  return sources.flatMap((src) => all[`${src.name}|${src.baseUrl}`]?.models ?? []);
}
