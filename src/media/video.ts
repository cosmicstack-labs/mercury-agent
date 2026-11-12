/**
 * Calling a video or music model (ADR-042 phase 3). These take from
 * seconds to minutes, so they run as background jobs (jobs.ts); the calls
 * here just wait for the result.
 *
 *  Video
 *   - Gemini Omni (gemini-omni-*): POST /v1beta/interactions with
 *     response_format {type: "video", aspect_ratio, resolution, duration};
 *     the MP4 comes back inline in steps[type=model_output].content[type=video].
 *   - OpenAI Videos API shape (/videos, poll /videos/{id}, /videos/{id}/content):
 *     what gateways such as LiteLLM serve (Sora itself was retired in 2026).
 *  Music
 *   - Gemini Lyria (lyria-*): the same Interactions call; MP3 inline.
 *   - ElevenLabs Music: POST /v1/music → the audio file.
 */
import { readFileSync } from 'node:fs';
import type { MediaEndpoint } from '../providers/base.js';
import type { MediaModel } from './catalog.js';
import { mimeOf } from '../artifacts/classify.js';
import { ImageGenerationError } from './image.js';

export interface VideoRequest {
  prompt: string;
  aspect?: 'landscape' | 'portrait';
  /** 3–15 seconds (Gemini Omni); gateways round to what their model takes. */
  seconds?: number;
  resolution?: '360p' | '720p' | '1080p';
  /** A still to animate or keep characters consistent with. */
  references?: string[];
  signal?: AbortSignal;
}

export interface MusicRequest {
  prompt: string;
  seconds?: number;
  instrumental?: boolean;
  signal?: AbortSignal;
}

export interface MediaFile {
  bytes: Buffer;
  mime: string;
  note?: string;
}

const VIDEO_TIMEOUT_MS = 15 * 60_000;
const MUSIC_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 5000;

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timed out')), ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

async function failure(res: Response): Promise<ImageGenerationError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown; message?: string };
    const detail = Array.isArray(j.detail) ? (j.detail[0] as { msg?: string })?.msg : typeof j.detail === 'string' ? j.detail : (j.detail as { message?: string } | undefined)?.message;
    message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? detail ?? j.message ?? message;
  } catch { /* not JSON */ }
  return new ImageGenerationError(`${res.status}: ${message || res.statusText}`, res.status);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.round(n), lo), hi);

interface InteractionContent { type?: string; data?: string; uri?: string; mime_type?: string; text?: string }

/** The first output of a kind in an Interactions response, and any text with it. */
async function interactionOutput(body: unknown, kind: 'video' | 'audio', ep: MediaEndpoint, fetchImpl: typeof fetch, signal: AbortSignal): Promise<MediaFile> {
  const steps = (body as { steps?: Array<{ type?: string; content?: InteractionContent[] }> }).steps ?? [];
  let note = '';
  for (const step of steps) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content ?? []) {
      if (c.type === 'text' && c.text) note += c.text;
      if (c.type !== kind) continue;
      const mime = c.mime_type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
      if (c.data) return { bytes: Buffer.from(c.data, 'base64'), mime, ...(note ? { note } : {}) };
      if (c.uri) {
        const res = await fetchImpl(c.uri, { headers: ep.headers, signal });
        if (!res.ok) throw await failure(res);
        return { bytes: Buffer.from(await res.arrayBuffer()), mime, ...(note ? { note } : {}) };
      }
    }
  }
  throw new ImageGenerationError(note ? `The model answered in words instead: ${note.slice(0, 300)}` : `The model returned no ${kind}`);
}

async function geminiOmni(m: MediaModel, ep: MediaEndpoint, req: VideoRequest, fetchImpl: typeof fetch): Promise<MediaFile> {
  const t = withTimeout(req.signal, VIDEO_TIMEOUT_MS);
  try {
    const refs = req.references?.slice(0, 6) ?? [];
    const input = refs.length
      ? [{ type: 'text', text: req.prompt }, ...refs.map((f) => ({ type: 'image', data: readFileSync(f).toString('base64'), mime_type: mimeOf(f) || 'image/png' }))]
      : req.prompt;
    const res = await fetchImpl(`${ep.baseUrl}/interactions`, {
      method: 'POST',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m.model,
        input,
        response_format: {
          type: 'video',
          aspect_ratio: req.aspect === 'portrait' ? '9:16' : '16:9',
          resolution: req.resolution ?? '720p',
          duration: `${clamp(req.seconds ?? 8, 3, 15)}s`,
        },
      }),
      signal: t.signal,
    });
    if (!res.ok) throw await failure(res);
    return await interactionOutput(await res.json(), 'video', ep, fetchImpl, t.signal);
  } finally {
    t.done();
  }
}

async function openAIVideos(m: MediaModel, ep: MediaEndpoint, req: VideoRequest, fetchImpl: typeof fetch): Promise<MediaFile> {
  const t = withTimeout(req.signal, VIDEO_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ep.baseUrl}/videos`, {
      method: 'POST',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m.model,
        prompt: req.prompt,
        size: req.aspect === 'portrait' ? '720x1280' : '1280x720',
        seconds: String(clamp(req.seconds ?? 8, 2, 20)),
      }),
      signal: t.signal,
    });
    if (!res.ok) throw await failure(res);
    let job = await res.json() as { id?: string; status?: string; error?: { message?: string } };
    const jobId = job.id;
    if (!jobId) throw new ImageGenerationError('The server started no video job');
    while (job.status !== 'completed') {
      if (job.status === 'failed' || job.status === 'expired' || job.status === 'cancelled') {
        throw new ImageGenerationError(`The video job ${job.status}${job.error?.message ? `: ${job.error.message}` : ''}`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      t.signal.throwIfAborted();
      const poll = await fetchImpl(`${ep.baseUrl}/videos/${encodeURIComponent(jobId)}`, { headers: ep.headers, signal: t.signal });
      if (!poll.ok) throw await failure(poll);
      job = { ...(await poll.json() as typeof job), id: jobId };
    }
    const content = await fetchImpl(`${ep.baseUrl}/videos/${encodeURIComponent(jobId)}/content`, { headers: ep.headers, signal: t.signal });
    if (!content.ok) throw await failure(content);
    return { bytes: Buffer.from(await content.arrayBuffer()), mime: content.headers.get('content-type')?.split(';')[0] || 'video/mp4' };
  } finally {
    t.done();
  }
}

export async function generateVideoWith(m: MediaModel, ep: MediaEndpoint, req: VideoRequest, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaFile> {
  if (m.backend === 'gemini-omni') return geminiOmni(m, ep, req, fetchImpl);
  if (m.backend === 'openai-videos') return openAIVideos(m, ep, req, fetchImpl);
  throw new ImageGenerationError(`${m.label} doesn't make videos`);
}

async function geminiLyria(m: MediaModel, ep: MediaEndpoint, req: MusicRequest, fetchImpl: typeof fetch): Promise<MediaFile> {
  const t = withTimeout(req.signal, MUSIC_TIMEOUT_MS);
  try {
    // Lyria takes length and "instrumental" as words in the prompt; clip models are always 30 s.
    const clip = /clip/.test(m.model);
    const prompt = [
      req.prompt.trim(),
      req.instrumental ? 'Instrumental only, no vocals.' : '',
      !clip && req.seconds ? `About ${clamp(req.seconds, 10, 300)} seconds long.` : '',
    ].filter(Boolean).join(' ');
    const res = await fetchImpl(`${ep.baseUrl}/interactions`, {
      method: 'POST',
      headers: { ...ep.headers, 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({ model: m.model, input: prompt }),
      signal: t.signal,
    });
    if (!res.ok) throw await failure(res);
    return await interactionOutput(await res.json(), 'audio', ep, fetchImpl, t.signal);
  } finally {
    t.done();
  }
}

async function elevenLabsMusic(m: MediaModel, ep: MediaEndpoint, req: MusicRequest, fetchImpl: typeof fetch): Promise<MediaFile> {
  const t = withTimeout(req.signal, MUSIC_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ep.baseUrl}/music?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        model_id: m.model,
        ...(req.seconds ? { music_length_ms: clamp(req.seconds, 3, 600) * 1000 } : {}),
        ...(req.instrumental ? { force_instrumental: true } : {}),
      }),
      signal: t.signal,
    });
    if (!res.ok) throw await failure(res);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new ImageGenerationError('ElevenLabs sent no audio');
    return { bytes, mime: 'audio/mpeg' };
  } finally {
    t.done();
  }
}

export async function generateMusicWith(m: MediaModel, ep: MediaEndpoint, req: MusicRequest, fetchImpl: typeof fetch = globalThis.fetch): Promise<MediaFile> {
  if (m.backend === 'gemini-lyria') return geminiLyria(m, ep, req, fetchImpl);
  if (m.backend === 'elevenlabs-music') return elevenLabsMusic(m, ep, req, fetchImpl);
  throw new ImageGenerationError(`${m.label} doesn't make music`);
}
