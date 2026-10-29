import { Hono } from 'hono';
import { loadConfig } from '../../utils/config.js';
import { secretValue } from '../../plugins/store.js';
import { audioExtension, pickSpeechEngine, transcribeBytes } from '../../plugins/transcribe.js';

/**
 * Dictation for every client: speak instead of typing.
 *
 *   GET  /api/transcribe              { available, engine } — which speech service would be used
 *   POST /api/transcribe[?language=]  raw audio body (audio/webm, audio/mp4, …) → { text, engine }
 *
 * Uses a service the owner already set up (OpenAI provider, else a Deepgram
 * or ElevenLabs voice key). With none, 412 { needs: 'speech' } so the app can
 * say how to turn it on. Audio is sent once and not kept.
 */

const MAX_BYTES = 25 * 1024 * 1024;

type Fetch = typeof fetch;
let doFetch: Fetch | undefined;
/** Test seam. */
export function setTranscribeFetch(f: Fetch | undefined): void { doFetch = f; }

function engine() {
  return pickSpeechEngine(loadConfig().providers.openai, secretValue);
}

const transcribe = new Hono();

transcribe.get('/api/transcribe', (c) => {
  const e = engine();
  return c.json({ available: !!e, engine: e?.label ?? null });
});

transcribe.post('/api/transcribe', async (c) => {
  const e = engine();
  if (!e) {
    return c.json({ error: 'Voice typing needs a speech service: an OpenAI key (Settings → Models), or a Deepgram or ElevenLabs key (Settings → Voice).', needs: 'speech' }, 412);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BYTES) return c.json({ error: 'That recording is too long (over 25 MB). Keep dictation under about 20 minutes.' }, 413);
  const mime = (c.req.header('content-type') ?? 'audio/webm').toLowerCase();
  if (!mime.startsWith('audio/') && !mime.startsWith('video/webm') && mime !== 'application/octet-stream') {
    return c.json({ error: 'Send the recording as audio.' }, 415);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return c.json({ error: 'That recording is too long (over 25 MB).' }, 413);
  const language = c.req.query('language');
  const lang = language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ? language : undefined;
  try {
    const text = await transcribeBytes(bytes, mime, `dictation.${audioExtension(mime)}`, e, { fetch: doFetch, language: lang });
    return c.json({ text, engine: e.label });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message === 'nothing was recorded' ? "Didn't catch anything. Check the microphone and try again." : `Couldn't transcribe: ${message}`, engine: e.label }, 502);
  }
});

export default transcribe;
