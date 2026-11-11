/**
 * Media generation for the agent, its commands and the apps (ADR-042).
 *
 * Which model makes an image, in order:
 *   1. the one asked for (a tool argument, /image --model, a desktop pick)
 *   2. the owner's default for images, then its fallbacks (media-prefs.json)
 *   3. automatic: the best image model found on the configured providers,
 *      the current chat provider's first
 * A model that fails hands over to the next (at most three are tried).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeName } from '../artifacts/output-dir.js';
import { logger } from '../utils/logger.js';
import { imageModels, knownImageModels, musicModels, parseRef, videoModels, type MediaKind, type MediaModel, type MediaSource } from './catalog.js';
import { generateMusicWith, generateVideoWith, type MusicRequest, type VideoRequest } from './video.js';
import { generateWith, ImageGenerationError, type ImageRequest } from './image.js';
import { loadMediaPrefs } from './prefs.js';

export interface MediaHost {
  /** The configured providers, in the registry's order. */
  sources(): MediaSource[];
  /** The provider the chat is using now (preferred for automatic picks). */
  currentProvider(): string | undefined;
}

export interface ImageJob extends Omit<ImageRequest, 'signal'> {
  /** "provider::model" to use this one only. */
  model?: string;
  signal?: AbortSignal;
}

export interface ImageJobResult {
  files: string[];
  model: MediaModel;
  /** Models that failed before this one, with why. */
  failed: Array<{ ref: string; error: string }>;
  revisedPrompt?: string;
  note?: string;
  ms: number;
}

/**
 * Models the provider says this account can't use (a free tier with no
 * quota, no billing): skipped by automatic picks for a day instead of
 * failing first on every request. A model asked for by name is still tried.
 */
const NO_QUOTA = /limit:\s*0\b|free tier|upgrade your (tier|plan)|billing (is )?(not|required)|insufficient[_ ]quota|not available (on|for) your (plan|tier)|payment required/i;
const NO_QUOTA_MS = 24 * 60 * 60 * 1000;
const unusable = new Map<string, { until: number; why: string }>();

export function noteMediaFailure(ref: string, error: string, now = Date.now()): void {
  if (NO_QUOTA.test(error)) unusable.set(ref, { until: now + NO_QUOTA_MS, why: 'no quota on this account' });
}

/** Why a model is being skipped right now, if it is. */
export function unusableReason(ref: string, now = Date.now()): string | undefined {
  const u = unusable.get(ref);
  if (!u) return undefined;
  if (u.until < now) { unusable.delete(ref); return undefined; }
  return u.why;
}

/** Test hook. */
export function resetUnusable(): void {
  unusable.clear();
}

/** Better-known models first when picking automatically, per kind. */
const PREFERENCE: Record<string, RegExp[]> = {
  image: [/gpt-image|chatgpt-image/i, /nano-banana|gemini-[\w.-]*-image/i, /flux/i, /seedream/i, /imagen/i, /grok-imagine|grok-2-image/i, /qwen-image|z-image/i, /dall-e-3/i],
  video: [/omni/i, /veo/i, /sora/i, /kling/i, /seedance/i, /hailuo|minimax/i, /runway|gen-?4/i, /luma|ray/i, /wan/i, /ltx/i],
  music: [/lyria-3\.5|lyria-3-pro/i, /music_v2_5/i, /lyria/i, /music_v2/i, /music/i],
  speech: [],
};

function rank(m: MediaModel): number {
  const list = PREFERENCE[m.kind] ?? [];
  const i = list.findIndex((re) => re.test(m.model));
  return i < 0 ? list.length : i;
}

/** The automatic pick order among known models. */
export function autoOrder(models: MediaModel[], currentProvider?: string): MediaModel[] {
  return [...models].sort((a, b) => {
    const pa = a.provider === currentProvider ? 0 : 1;
    const pb = b.provider === currentProvider ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const r = rank(a) - rank(b);
    if (r) return r;
    // Newer versions tend to sort later by name ("gpt-image-1.5" > "gpt-image-1").
    return b.model.localeCompare(a.model, undefined, { numeric: true });
  });
}

export interface ImageSetup {
  /** The owner's default, if set (and whether it is still offered). */
  default?: { ref: string; available: boolean };
  /** What "automatic" would use now. */
  auto?: MediaModel;
  models: MediaModel[];
}

export class MediaService {
  constructor(private readonly host: MediaHost, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  /** A configured provider's endpoint and auth (fresh), for other callers that need it. */
  async endpointFor(name: string): Promise<import('../providers/base.js').MediaEndpoint | undefined> {
    return this.host.sources().find((s) => s.name === name)?.endpoint().catch(() => undefined);
  }

  /** The providers, for the speech service (same sources as images). */
  sourcesForSpeech(): () => MediaSource[] {
    return () => this.host.sources();
  }

  async imageModels(opts: { refresh?: boolean } = {}): Promise<MediaModel[]> {
    return imageModels(this.host.sources(), { refresh: opts.refresh, fetchImpl: this.fetchImpl });
  }

  /** Known without network: for tool descriptions and quick checks. */
  knownImageModels(): MediaModel[] {
    return knownImageModels(this.host.sources());
  }

  async models(kind: Exclude<MediaKind, 'speech'>, opts: { refresh?: boolean } = {}): Promise<MediaModel[]> {
    const lister = kind === 'video' ? videoModels : kind === 'music' ? musicModels : imageModels;
    return lister(this.host.sources(), { refresh: opts.refresh, fetchImpl: this.fetchImpl });
  }

  async setup(kind: Exclude<MediaKind, 'speech'>, opts: { refresh?: boolean } = {}): Promise<ImageSetup> {
    const models = await this.models(kind, opts);
    const primary = loadMediaPrefs()[kind]?.primary;
    return {
      ...(primary ? { default: { ref: primary, available: models.some((m) => m.ref === primary) } } : {}),
      auto: autoOrder(models, this.host.currentProvider()).find((m) => !unusableReason(m.ref)),
      models,
    };
  }

  async imageSetup(opts: { refresh?: boolean } = {}): Promise<ImageSetup> {
    const models = await this.imageModels(opts);
    const primary = loadMediaPrefs().image?.primary;
    return {
      ...(primary ? { default: { ref: primary, available: models.some((m) => m.ref === primary) } } : {}),
      auto: autoOrder(models, this.host.currentProvider()).find((m) => !unusableReason(m.ref)),
      models,
    };
  }

  /** The models to try, in order (at most three). */
  async imageChain(requested?: string): Promise<MediaModel[]> {
    return this.chain('image', requested);
  }

  async chain(kind: Exclude<MediaKind, 'speech'>, requested?: string): Promise<MediaModel[]> {
    const models = await this.models(kind);
    const byRef = new Map(models.map((m) => [m.ref, m]));
    const fromRef = (ref: string): MediaModel | undefined => {
      const known = byRef.get(ref);
      if (known) return known;
      // A model the owner named that discovery didn't list: try it through its provider's Images API.
      const p = parseRef(ref);
      if (!p || !this.host.sources().some((s) => s.name === p.provider) || kind === 'music') return undefined;
      return { ref, provider: p.provider, model: p.model, kind, backend: kind === 'video' ? 'openai-videos' : 'openai-images', label: p.model, group: p.provider, canEdit: true };
    };
    if (requested) {
      const exact = fromRef(requested) ?? models.find((m) => m.model === requested || m.label.toLowerCase() === requested.toLowerCase());
      return exact ? [exact] : [];
    }
    const prefs = loadMediaPrefs()[kind];
    const chain: MediaModel[] = [];
    for (const ref of [prefs?.primary, ...(prefs?.fallbacks ?? [])]) {
      const m = ref ? fromRef(ref) : undefined;
      if (m && !chain.some((c) => c.ref === m.ref)) chain.push(m);
    }
    for (const m of autoOrder(models, this.host.currentProvider())) {
      if (chain.length >= 3) break;
      if (!chain.some((c) => c.ref === m.ref) && !unusableReason(m.ref)) chain.push(m);
    }
    return chain.slice(0, 3);
  }

  /** A video: Gemini Omni or an OpenAI Videos API gateway; can take minutes (run it as a job). */
  generateVideo(req: VideoRequest & { model?: string }, outDir: string): Promise<MediaJobResult> {
    return runChain(this, this.host, 'video', req, outDir, (m, ep) => generateVideoWith(m, ep, req, this.fetchImpl));
  }

  /** A song or clip: Gemini Lyria or ElevenLabs Music. */
  generateMusic(req: MusicRequest & { model?: string }, outDir: string): Promise<MediaJobResult> {
    return runChain(this, this.host, 'music', req, outDir, (m, ep) => generateMusicWith(m, ep, req, this.fetchImpl));
  }

  /** Generate, save into `outDir`, and say which model made it. */
  async generateImage(job: ImageJob, outDir: string): Promise<ImageJobResult> {
    const started = Date.now();
    let chain = await this.imageChain(job.model);
    if (job.references?.length) {
      const editors = chain.filter((m) => m.canEdit);
      chain = editors.length ? editors : chain;
    }
    if (!chain.length) {
      throw new ImageGenerationError(job.model
        ? `No image model "${job.model}" on the configured providers.`
        : 'No image model is set up. Add a provider that makes images (OpenAI, OpenRouter, LiteLLM, AI/ML API, Mercury Cloud…) and pick one with /media.');
    }
    const failed: ImageJobResult['failed'] = [];
    for (const m of chain) {
      if (job.signal?.aborted) break;
      const src = this.host.sources().find((s) => s.name === m.provider);
      const ep = await src?.endpoint().catch(() => undefined);
      if (!ep) { failed.push({ ref: m.ref, error: 'provider not reachable' }); continue; }
      try {
        const result = await generateWith(m, ep, job, this.fetchImpl);
        mkdirSync(outDir, { recursive: true });
        const stem = slug(job.prompt);
        const files = result.images.map((img, i) => {
          const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/webp' ? 'webp' : img.mime === 'image/gif' ? 'gif' : 'png';
          const name = freeName(outDir, `${stem}${result.images.length > 1 ? `-${i + 1}` : ''}.${ext}`);
          const file = join(outDir, name);
          writeFileSync(file, img.bytes);
          return file;
        });
        return { files, model: m, failed, ms: Date.now() - started, ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}), ...(result.note ? { note: result.note } : {}) };
      } catch (err) {
        if (job.signal?.aborted) throw err;
        const error = err instanceof Error ? err.message : String(err);
        logger.warn({ model: m.ref, error }, 'Image generation failed; trying the next model');
        noteMediaFailure(m.ref, error);
        failed.push({ ref: m.ref, error });
      }
    }
    throw new ImageGenerationError(`Image generation failed: ${failed.map((f) => `${f.ref} (${f.error})`).join('; ')}`);
  }
}

/** A video or song, saved into `outDir`. */
export interface MediaJobResult {
  file: string;
  model: MediaModel;
  failed: Array<{ ref: string; error: string }>;
  note?: string;
  ms: number;
}

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };

/** Try each model in turn; save what the first one that works makes. */
export async function runChain<R extends { signal?: AbortSignal }>(
  service: MediaService,
  host: MediaHost,
  kind: 'video' | 'music',
  req: R & { prompt: string; model?: string; references?: string[] },
  outDir: string,
  call: (m: MediaModel, ep: NonNullable<Awaited<ReturnType<MediaSource['endpoint']>>>) => Promise<{ bytes: Buffer; mime: string; note?: string }>,
): Promise<MediaJobResult> {
  const started = Date.now();
  let chain = await service.chain(kind, req.model);
  if (req.references?.length) {
    const editors = chain.filter((m) => m.canEdit);
    chain = editors.length ? editors : chain;
  }
  if (!chain.length) {
    throw new ImageGenerationError(req.model
      ? `No ${kind} model "${req.model}" on the configured providers.`
      : kind === 'video'
        ? 'No video model is set up. A Gemini key (Settings → Voice) gives Gemini Omni video; gateways such as LiteLLM or Mercury Cloud can serve others. Pick one with /media.'
        : 'No music model is set up. A Gemini key (Lyria) or an ElevenLabs key (Settings → Voice) makes music. Pick one with /media.');
  }
  const failed: MediaJobResult['failed'] = [];
  for (const m of chain) {
    if (req.signal?.aborted) break;
    const ep = await host.sources().find((s) => s.name === m.provider)?.endpoint().catch(() => undefined);
    if (!ep) { failed.push({ ref: m.ref, error: 'provider not reachable' }); continue; }
    try {
      const out = await call(m, ep);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, freeName(outDir, `${slug(req.prompt)}.${EXT[out.mime] ?? (kind === 'video' ? 'mp4' : 'mp3')}`));
      writeFileSync(file, out.bytes);
      return { file, model: m, failed, ms: Date.now() - started, ...(out.note ? { note: out.note } : {}) };
    } catch (err) {
      if (req.signal?.aborted) throw err;
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ model: m.ref, kind, error }, 'Media generation failed; trying the next model');
      noteMediaFailure(m.ref, error);
      failed.push({ ref: m.ref, error });
    }
  }
  throw new ImageGenerationError(`${kind === 'video' ? 'Video' : 'Music'} generation failed: ${failed.map((f) => `${f.ref} (${f.error})`).join('; ')}`);
}

/** "A red fox in snow, watercolor" → "red-fox-in-snow-watercolor". */
export function slug(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w && !/^(a|an|the|of|and|image|picture|photo|generate|create|make|draw)$/.test(w));
  return words.slice(0, 6).join('-').slice(0, 60) || 'image';
}
