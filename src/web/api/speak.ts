import { Hono } from 'hono';
import { currentSpeechEngine, NO_SPEECH_SERVICE } from '../../plugins/speech-choice.js';
import { SPEAK_MAX_CHARS, speechMime, synthesizeSpeech } from '../../plugins/speak.js';

/**
 * Read aloud for every client: text in, speech out.
 *
 *   GET  /api/speak          { available, engine, maxChars } — which speech service would be used
 *   POST /api/speak { text } → audio/mpeg (audio/wav from Gemini)
 *
 * Uses the speech service voice typing uses (the voice chosen in Settings →
 * Voice when it has a key, else OpenAI, Gemini, Deepgram or ElevenLabs). With none, 412 { needs: 'speech' } so
 * the app can say how to turn it on. Clients send a long reply in parts of
 * at most `maxChars`, so the first words play while the rest is made.
 */

type Fetch = typeof fetch;
let doFetch: Fetch | undefined;
/** Test seam. */
export function setSpeakFetch(f: Fetch | undefined): void { doFetch = f; }

function engine() {
  return currentSpeechEngine('speak');
}

const speak = new Hono();

speak.get('/api/speak', (c) => {
  const e = engine();
  return c.json({ available: !!e, engine: e?.label ?? null, maxChars: SPEAK_MAX_CHARS });
});

speak.post('/api/speak', async (c) => {
  const e = engine();
  if (!e) {
    return c.json({ error: `Reading aloud needs ${NO_SPEECH_SERVICE}`, needs: 'speech' }, 412);
  }
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'Nothing to read.' }, 400);
  if (text.length > SPEAK_MAX_CHARS) return c.json({ error: `Send at most ${SPEAK_MAX_CHARS} characters at a time.`, maxChars: SPEAK_MAX_CHARS }, 413);
  try {
    const audio = await synthesizeSpeech(text, e, { fetch: doFetch, signal: c.req.raw.signal });
    return new Response(audio, { headers: { 'Content-Type': speechMime(e), 'Cache-Control': 'no-store', 'X-Speech-Engine': e.label } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Couldn't read that aloud: ${message}`, engine: e.label }, 502);
  }
});

export default speak;
