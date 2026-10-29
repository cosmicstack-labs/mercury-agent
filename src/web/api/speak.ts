import { Hono } from 'hono';
import { loadConfig } from '../../utils/config.js';
import { secretValue } from '../../plugins/store.js';
import { pickSpeechEngine } from '../../plugins/transcribe.js';
import { SPEAK_MAX_CHARS, synthesizeSpeech } from '../../plugins/speak.js';

/**
 * Read aloud for every client: text in, speech out.
 *
 *   GET  /api/speak          { available, engine, maxChars } — which speech service would be used
 *   POST /api/speak { text } → audio/mpeg
 *
 * Uses the speech service voice typing uses (OpenAI provider, else a
 * Deepgram or ElevenLabs voice key). With none, 412 { needs: 'speech' } so
 * the app can say how to turn it on. Clients send a long reply in parts of
 * at most `maxChars`, so the first words play while the rest is made.
 */

type Fetch = typeof fetch;
let doFetch: Fetch | undefined;
/** Test seam. */
export function setSpeakFetch(f: Fetch | undefined): void { doFetch = f; }

function engine() {
  return pickSpeechEngine(loadConfig().providers.openai, secretValue);
}

const speak = new Hono();

speak.get('/api/speak', (c) => {
  const e = engine();
  return c.json({ available: !!e, engine: e?.label ?? null, maxChars: SPEAK_MAX_CHARS });
});

speak.post('/api/speak', async (c) => {
  const e = engine();
  if (!e) {
    return c.json({ error: 'Reading aloud needs a speech service: an OpenAI key (Settings → Models), or a Deepgram or ElevenLabs key (Settings → Voice).', needs: 'speech' }, 412);
  }
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'Nothing to read.' }, 400);
  if (text.length > SPEAK_MAX_CHARS) return c.json({ error: `Send at most ${SPEAK_MAX_CHARS} characters at a time.`, maxChars: SPEAK_MAX_CHARS }, 413);
  try {
    const audio = await synthesizeSpeech(text, e, { fetch: doFetch, signal: c.req.raw.signal });
    return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Speech-Engine': e.label } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Couldn't read that aloud: ${message}`, engine: e.label }, 502);
  }
});

export default speak;
