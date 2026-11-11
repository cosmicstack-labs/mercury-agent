/**
 * Calling an image model. Two wire formats cover the providers Mercury has:
 *
 *  - OpenAI Images API: POST /images/generations (JSON) and /images/edits
 *    (multipart, reference images). OpenAI itself, LiteLLM, AI/ML API,
 *    Runcrate, Atlas Cloud, Mercury Cloud, Ollama and most self-hosted
 *    servers expose it. Results come back as b64_json or a URL.
 *  - OpenRouter: chat completions with modalities ["image","text"]; images
 *    come back in choices[0].message.images[].image_url.url as data URLs.
 *    Reference images go in the user message.
 *
 * Options are simple (aspect, quality, count) and mapped to what each
 * format takes; a value a server doesn't take is left out, not guessed.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { MediaEndpoint } from '../providers/base.js';
import type { MediaModel } from './catalog.js';
import { mimeOf } from '../artifacts/classify.js';

export type Aspect = 'square' | 'landscape' | 'portrait';
export type Quality = 'auto' | 'low' | 'medium' | 'high';

export interface ImageRequest {
  prompt: string;
  aspect?: Aspect;
  quality?: Quality;
  count?: number;
  /** Local files to edit or take as references. */
  references?: string[];
  signal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  /** The prompt as the model rewrote it, when it says. */
  revisedPrompt?: string;
  /** Text the model wrote alongside (OpenRouter chat). */
  note?: string;
}

const TIMEOUT_MS = 180_000;

export class ImageGenerationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

function sizeFor(model: string, aspect: Aspect): string {
  if (/dall-e-3/i.test(model)) return aspect === 'landscape' ? '1792x1024' : aspect === 'portrait' ? '1024x1792' : '1024x1024';
  if (/dall-e-2/i.test(model)) return '1024x1024';
  return aspect === 'landscape' ? '1536x1024' : aspect === 'portrait' ? '1024x1536' : '1024x1024';
}

const RATIO: Record<Aspect, string> = { square: '1:1', landscape: '16:9', portrait: '9:16' };

function withTimeout(signal: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Image generation timed out')), TIMEOUT_MS);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

async function errorOf(res: Response): Promise<ImageGenerationError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: string };
    message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? j.detail ?? message;
  } catch { /* not JSON */ }
  return new ImageGenerationError(`${res.status}: ${message || res.statusText}`, res.status);
}

function decodeDataUrl(url: string): GeneratedImage | undefined {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mime: m[1] || 'image/png', bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
}

async function download(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<GeneratedImage> {
  const data = decodeDataUrl(url);
  if (data) return data;
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new ImageGenerationError(`Downloading the image failed (${res.status})`, res.status);
  return { mime: res.headers.get('content-type')?.split(';')[0] || 'image/png', bytes: Buffer.from(await res.arrayBuffer()) };
}

function sniffMime(bytes: Buffer, fallback = 'image/png'): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return fallback;
}

async function openAIImages(m: MediaModel, ep: MediaEndpoint, req: ImageRequest, fetchImpl: typeof fetch): Promise<ImageResult> {
  const aspect = req.aspect ?? 'square';
  const n = Math.min(Math.max(req.count ?? 1, 1), 4);
  const quality = req.quality && req.quality !== 'auto' && /gpt-image|chatgpt-image/i.test(m.model) ? req.quality : undefined;
  const t = withTimeout(req.signal);
  try {
    let res: Response;
    if (req.references?.length) {
      const form = new FormData();
      form.set('model', m.model);
      form.set('prompt', req.prompt);
      form.set('n', String(n));
      form.set('size', sizeFor(m.model, aspect));
      if (quality) form.set('quality', quality);
      for (const file of req.references.slice(0, 5)) {
        const blob = new Blob([new Uint8Array(readFileSync(file))], { type: mimeOf(file) || 'image/png' });
        form.append(/gpt-image|chatgpt-image/i.test(m.model) ? 'image[]' : 'image', blob, basename(file));
      }
      res = await fetchImpl(`${ep.baseUrl}/images/edits`, { method: 'POST', headers: ep.headers, body: form, signal: t.signal });
    } else {
      res = await fetchImpl(`${ep.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { ...ep.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: m.model,
          prompt: req.prompt,
          n,
          size: sizeFor(m.model, aspect),
          ...(quality ? { quality } : {}),
          // dall-e answers with a URL unless asked; gpt-image always sends base64 and rejects the field.
          ...(/dall-e/i.test(m.model) ? { response_format: 'b64_json' } : {}),
        }),
        signal: t.signal,
      });
    }
    if (!res.ok) throw await errorOf(res);
    const body = await res.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
    const images: GeneratedImage[] = [];
    for (const d of body.data ?? []) {
      if (d.b64_json) {
        const bytes = Buffer.from(d.b64_json, 'base64');
        images.push({ bytes, mime: sniffMime(bytes) });
      } else if (d.url) {
        images.push(await download(d.url, fetchImpl, t.signal));
      }
    }
    if (!images.length) throw new ImageGenerationError('The model returned no image');
    const revised = body.data?.find((d) => d.revised_prompt)?.revised_prompt;
    return { images, ...(revised ? { revisedPrompt: revised } : {}) };
  } finally {
    t.done();
  }
}

async function openRouterChat(m: MediaModel, ep: MediaEndpoint, req: ImageRequest, fetchImpl: typeof fetch): Promise<ImageResult> {
  const t = withTimeout(req.signal);
  try {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
    for (const file of req.references?.slice(0, 5) ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${mimeOf(file) || 'image/png'};base64,${readFileSync(file).toString('base64')}` } });
    }
    const res = await fetchImpl(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m.model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
        ...(req.aspect ? { image_config: { aspect_ratio: RATIO[req.aspect] } } : {}),
      }),
      signal: t.signal,
    });
    if (!res.ok) throw await errorOf(res);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> } }> };
    const message = body.choices?.[0]?.message;
    const images: GeneratedImage[] = [];
    for (const img of message?.images ?? []) {
      if (img.image_url?.url) images.push(await download(img.image_url.url, fetchImpl, t.signal));
    }
    if (!images.length) throw new ImageGenerationError(message?.content ? `The model answered in words instead: ${message.content.slice(0, 200)}` : 'The model returned no image');
    return { images, ...(message?.content ? { note: message.content } : {}) };
  } finally {
    t.done();
  }
}

/** Gemini image models (Nano Banana): generateContent with image output; references go in as inline images. */
async function geminiImage(m: MediaModel, ep: MediaEndpoint, req: ImageRequest, fetchImpl: typeof fetch): Promise<ImageResult> {
  const t = withTimeout(req.signal);
  try {
    const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
    for (const file of req.references?.slice(0, 5) ?? []) {
      parts.push({ inlineData: { mimeType: mimeOf(file) || 'image/png', data: readFileSync(file).toString('base64') } });
    }
    const count = Math.min(Math.max(req.count ?? 1, 1), 4);
    const images: GeneratedImage[] = [];
    let note = '';
    // One image per call: Gemini returns a single picture per candidate.
    for (let i = 0; i < count; i++) {
      const res = await fetchImpl(`${ep.baseUrl}/models/${encodeURIComponent(m.model)}:generateContent`, {
        method: 'POST',
        headers: { ...ep.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(req.aspect ? { imageConfig: { aspectRatio: RATIO[req.aspect] } } : {}),
          },
        }),
        signal: t.signal,
      });
      if (!res.ok) throw await errorOf(res);
      const body = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }; finishReason?: string }> };
      for (const p of body.candidates?.[0]?.content?.parts ?? []) {
        if (p.inlineData?.data) images.push({ bytes: Buffer.from(p.inlineData.data, 'base64'), mime: p.inlineData.mimeType || 'image/png' });
        else if (p.text) note += p.text;
      }
      if (!images.length) {
        const reason = body.candidates?.[0]?.finishReason;
        throw new ImageGenerationError(note ? `The model answered in words instead: ${note.slice(0, 200)}` : `The model returned no image${reason ? ` (${reason})` : ''}`);
      }
    }
    return { images, ...(note ? { note } : {}) };
  } finally {
    t.done();
  }
}

export async function generateWith(m: MediaModel, ep: MediaEndpoint, req: ImageRequest, fetchImpl: typeof fetch = globalThis.fetch): Promise<ImageResult> {
  if (m.backend === 'gemini-image') return geminiImage(m, ep, req, fetchImpl);
  return m.backend === 'openrouter-chat' ? openRouterChat(m, ep, req, fetchImpl) : openAIImages(m, ep, req, fetchImpl);
}
