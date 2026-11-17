import { Hono } from 'hono';
import { loadConfig } from '../../utils/config.js';
import { readSettings, secretValue } from '../../plugins/store.js';
import { voiceBriefing } from '../../plugins/channel-bridge.js';
import { pickSpeechEngine, preferredSpeech } from '../../plugins/transcribe.js';

/**
 * Voice calls from the phone, on Mercury's shared Rust voice engine
 * (crates/mercury-voice-mobile, the same links Optimus runs on the desktop).
 *
 *   POST /api/mobile/voice/session  { engine?: 'openai' | 'gemini' }
 *     → { engine, token, ephemeral: true, expiresAt, model, voice, url?, instructions, tools }
 *     → 409 { error, fallback: true } when no realtime voice can start (the app uses its own fallback)
 *
 * The phone never sees an API key: Mercury mints a short-lived token with the
 * owner's key, an OpenAI Realtime client secret or a Gemini Live ephemeral
 * auth token, for the engine the owner chose for voice (Settings → Voice,
 * Optimus's `voiceEngine`) when it has a key, else whichever has one.
 * Owner-authenticated like every /api route (a paired device's token is fine).
 *
 *   POST /api/mobile/voice/dictation  { engine?: 'openai' | 'gemini' | 'deepgram' | 'elevenlabs' }
 *     → { engine, token, ephemeral: true, expiresAt, model, url?, language? }
 *     → 409 { error, fallback: true, device: true, setup } when no speech service is set up
 *       (the phone then dictates with its own speech recognition)
 *   GET  /api/mobile/voice/capabilities
 *     → { call, callEngine?, callEngineName?, callSetup?, dictation, dictationEngine?, dictationEngineName?, dictationSetup?, dictationFallback? } (no provider calls)
 *
 * Live dictation (the phone's message box) is speech to text only, on the
 * same engine (crates/mercury-voice dictation.rs), with the speech service
 * every other listening feature uses (pickSpeechEngine: the owner's voice
 * choice in Settings → Voice first, else OpenAI, Gemini, Deepgram,
 * ElevenLabs): an OpenAI Realtime transcription session, a Gemini Live
 * session that only transcribes (an ephemeral auth token; the model never
 * answers), Deepgram streaming (a temporary token from /v1/auth/grant) or
 * ElevenLabs Scribe (a single-use token). With none, `dictationFallback:
 * 'device'`: the phone uses its own speech recognition.
 */

type Fetch = typeof fetch;
let doFetch: Fetch | undefined;
/** Test seam. */
export function setMobileVoiceFetch(f: Fetch | undefined): void { doFetch = f; }

export type MobileVoiceEngine = 'openai' | 'gemini';

/** Optimus's defaults (plugins/optimus manifest and crates/mercury-voice), so the phone sounds the same. */
export const VOICE_DEFAULTS = {
  openai: { model: 'gpt-realtime-2.1', voice: 'marin' },
  gemini: { model: 'gemini-3.8-live', voice: 'Kore' },
} as const;

/** How long a minted token can start a session. */
export const OPENAI_SECRET_SECONDS = 600;
export const GEMINI_START_SECONDS = 120;
/** Gemini: how long the token keeps working, including resuming the session every ~10 minutes. */
export const GEMINI_TOKEN_SECONDS = 30 * 60;

const OPENAI_BASE = 'https://api.openai.com/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The voice instructions, as Optimus gives its voice (plugins/optimus/companion/src/voice.rs),
 * for a phone instead of the computer; Mercury's own briefing (who it is, who the owner is) follows.
 */
export const PHONE_VOICE_INSTRUCTIONS = "You are Mercury, the user's AI assistant, talking out loud with them through the Mercury app on their phone. " +
  'Speak naturally and briefly: one or two sentences at a time, no lists, no markdown, no URLs read aloud. ' +
  "You can't act yourself, and you don't know today's news or anything current: for doing things (on their computer, the web, messages, files), " +
  "for news, facts that may have changed, or the user's own things (memory, files, calendar), call ask_mercury with a clear, complete request. " +
  'Mercury can search the web and use its tools, and when Optimus is on it can see and use their computer. ' +
  "Before a request, say two or three words at most ('On it.') and call ask_mercury straight away. " +
  "If you get updates on what Mercury is doing right now, say each one in a few words, present tense ('Opening Gmail'), and nothing else. " +
  "Never announce something as upcoming once an update or the answer shows it's done. " +
  'When ask_mercury returns, say what was done or found, briefly and in the past tense. ' +
  'Some actions need the user\'s approval. When you get an approval request, ask the user plainly whether to go ahead, wait for their answer, ' +
  'then call answer_approval. Never answer an approval yourself: only the user\'s own words count. ' +
  "Only say something is done when ask_mercury's answer says so; if it says something failed, couldn't be checked or was stopped, tell the user plainly. Never fill in a result yourself. " +
  "Links, lists and details go to the user's Mercury chat automatically; just say you've sent them. " +
  'When the user says goodbye or is done, say a short goodbye and call end_conversation.';

/** The same tools Optimus gives its voice (names and parameters the app's bridge answers). */
export const PHONE_VOICE_TOOLS = [
  {
    type: 'function',
    name: 'ask_mercury',
    description: 'Ask Mercury (it has memory, tools and files, and can use the computer when Optimus is on) a question or to do something. Returns the answer to speak back.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  { type: 'function', name: 'end_conversation', description: 'Stop listening, after saying goodbye.', parameters: { type: 'object', properties: {} } },
  {
    type: 'function',
    name: 'answer_approval',
    description: 'Report the user\'s answer to the approval you just asked them about. Only call it after they answered out loud.',
    parameters: { type: 'object', properties: { approved: { type: 'boolean', description: 'true only if the user clearly said yes' } }, required: ['approved'] },
  },
];

export function phoneInstructions(briefing: string = safeBriefing()): string {
  return briefing.trim() ? `${PHONE_VOICE_INSTRUCTIONS}\n\n${briefing.trim()}` : PHONE_VOICE_INSTRUCTIONS;
}

function safeBriefing(): string {
  try { return voiceBriefing(); } catch { return ''; }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

interface Keys {
  openai?: { apiKey: string; baseUrl: string };
  gemini?: { apiKey: string };
  deepgram?: { apiKey: string };
  elevenlabs?: { apiKey: string };
}

/** The keys Mercury hands Optimus (MERCURY_PROVIDER_OPENAI_API_KEY from the OpenAI provider, GEMINI_API_KEY from Settings → Voice). */
function availableKeys(): Keys {
  const out: Keys = {};
  try {
    const p = loadConfig().providers.openai;
    if (p?.apiKey && p.enabled !== false) out.openai = { apiKey: p.apiKey, baseUrl: p.baseUrl || OPENAI_BASE };
  } catch { /* no config */ }
  const gemini = secretValue('GEMINI_API_KEY');
  if (gemini) out.gemini = { apiKey: gemini };
  // The listening services' keys (Settings → Voice), as /api/transcribe finds them.
  const deepgram = secretValue('DEEPGRAM_API_KEY');
  if (deepgram) out.deepgram = { apiKey: deepgram };
  const elevenlabs = secretValue('ELEVENLABS_API_KEY');
  if (elevenlabs) out.elevenlabs = { apiKey: elevenlabs };
  return out;
}

function voiceSettings(): Record<string, unknown> {
  try { return readSettings('optimus'); } catch { return {}; }
}

/** The engine to use: the one asked for, else the owner's voice engine, else whichever has a key (OpenAI first, as Optimus defaults to it). */
export function pickEngine(keys: Keys, settings: Record<string, unknown>, asked?: string): MobileVoiceEngine | null {
  const has = (e: string | undefined): e is MobileVoiceEngine => (e === 'openai' || e === 'gemini') && !!keys[e];
  if (has(asked)) return asked;
  const chosen = str(settings.voiceEngine) ?? 'openai';
  if (has(chosen)) return chosen;
  if (keys.openai) return 'openai';
  if (keys.gemini) return 'gemini';
  return null;
}

export function realtimeUrl(baseUrl: string, model: string): string {
  const b = baseUrl.replace(/\/+$/, '').replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  return `${b}/realtime?model=${encodeURIComponent(model)}`;
}

/** Provider error messages can quote part of a key: never pass one on. */
export function redactKeys(text: string): string {
  return text
    .replace(/\b(sk-|sk_|ek_|AIza)[A-Za-z0-9_\-*.]{4,}/g, '$1…')
    // Deepgram keys are 40 hex characters.
    .replace(/\b[0-9a-f]{32,}\b/gi, '…');
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; err_msg?: string; detail?: { message?: string } | string };
    // OpenAI / Gemini: error; Deepgram: err_msg; ElevenLabs: detail.
    const m = typeof body.error === 'string' ? body.error : body.error?.message ?? body.err_msg
      ?? (typeof body.detail === 'string' ? body.detail : body.detail?.message);
    return m ? `${res.status}: ${redactKeys(m).slice(0, 300)}` : String(res.status);
  } catch {
    return String(res.status);
  }
}

interface Minted { token: string; expiresAt: string; url?: string }

// How a phone call hears the owner (noise and other people nearby) isn't set in the minted
// sessions: the engine (crates/mercury-voice, `phoneCall`, set by mercury-voice-mobile) sends it
// on connect. OpenAI: the whole `audio.input` (near_field noise reduction, semantic_vad) goes in
// session.update steps after the main one, so a field the model rejects never costs the call.
// Gemini: the token carries no liveConnectConstraints, so the app's setup message decides
// realtimeInputConfig (START_SENSITIVITY_LOW, prefix padding, silence).

async function mintOpenAI(key: { apiKey: string; baseUrl: string }, model: string, voice: string, signal?: AbortSignal): Promise<Minted> {
  const res = await (doFetch ?? fetch)(`${key.baseUrl.replace(/\/+$/, '')}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: OPENAI_SECRET_SECONDS },
      session: { type: 'realtime', model, audio: { output: { voice } } },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI didn't issue a voice token (${await errorText(res)})`);
  const body = (await res.json()) as { value?: unknown; expires_at?: unknown };
  if (typeof body.value !== 'string' || !body.value) throw new Error("OpenAI didn't return a voice token");
  const expires = typeof body.expires_at === 'number' ? body.expires_at * 1000 : Date.now() + OPENAI_SECRET_SECONDS * 1000;
  return { token: body.value, expiresAt: new Date(expires).toISOString(), url: realtimeUrl(key.baseUrl, model) };
}

async function mintGemini(key: { apiKey: string }, signal?: AbortSignal): Promise<Minted> {
  const now = Date.now();
  const expireTime = new Date(now + GEMINI_TOKEN_SECONDS * 1000).toISOString();
  const res = await (doFetch ?? fetch)(`${GEMINI_BASE}/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime: new Date(now + GEMINI_START_SECONDS * 1000).toISOString() }),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini didn't issue a voice token (${await errorText(res)})`);
  const body = (await res.json()) as { name?: unknown; expireTime?: unknown };
  if (typeof body.name !== 'string' || !body.name) throw new Error("Gemini didn't return a voice token");
  return { token: body.name, expiresAt: typeof body.expireTime === 'string' ? body.expireTime : expireTime };
}

export const NO_REALTIME_VOICE =
  'Voice calls on the phone need an OpenAI key (Settings → Models) or a Gemini key (Settings → Voice).';

// ── Live dictation ────────────────────────────────────────────────────────

export type DictationEngine = 'openai' | 'gemini' | 'deepgram' | 'elevenlabs';

/**
 * The engines' models (crates/mercury-voice dictation.rs uses the same defaults).
 * Gemini: the 2.5 native-audio Live model streams the input transcription word by word while
 * the owner talks (gemini-3.8-live only sends it when the turn ends), and with automatic
 * activity detection off and no activityEnd it never answers (checked against the live API).
 */
export const DICTATION_DEFAULTS = {
  openai: { model: 'gpt-live-transcribe' },
  gemini: { model: 'gemini-2.5-flash-native-audio-latest' },
  deepgram: { model: 'nova-3' },
  elevenlabs: { model: 'scribe_v2_realtime' },
} as const;

/** OpenAI client secret: how long it can start a session. */
export const DICTATION_SECRET_SECONDS = 300;
/** Deepgram's temporary token only has to be valid when the stream opens. */
export const DEEPGRAM_TOKEN_SECONDS = 60;
/** ElevenLabs single-use tokens last 15 minutes. */
export const ELEVENLABS_TOKEN_SECONDS = 15 * 60;

const DEEPGRAM_BASE = 'https://api.deepgram.com/v1';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/** No speech service: the phone dictates with its own speech recognition; this says how to do better. */
export const DICTATION_SETUP =
  "Dictation uses this phone's own speech recognition. For better dictation, add a Gemini, OpenAI, Deepgram or ElevenLabs key in Settings → Voice.";

/**
 * The engine for dictation: the one asked for (when it has a key), else exactly what every
 * other listening feature uses (pickSpeechEngine with the owner's voice choice, as Desktop's
 * voice typing and voice notes do), so there's one answer to "who listens".
 */
export function pickDictationEngine(keys: Keys, settings: Record<string, unknown>, asked?: string): DictationEngine | null {
  const secrets: Record<string, string | undefined> = {
    GEMINI_API_KEY: keys.gemini?.apiKey, DEEPGRAM_API_KEY: keys.deepgram?.apiKey, ELEVENLABS_API_KEY: keys.elevenlabs?.apiKey,
  };
  const e = pickSpeechEngine(keys.openai, (name) => secrets[name], [asked, ...preferredSpeech(settings, 'listen')]);
  return e ? e.kind : null;
}

/**
 * The Gemini Live session dictation opens (crates/mercury-voice dictation.rs gemini_setup):
 * transcribe what's heard, and with activity detection off the model never takes a turn.
 */
export function geminiDictationSetup(model: string): Record<string, unknown> {
  return {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    inputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  };
}

/** The language the owner speaks (Settings → Voice), or undefined to detect it. */
export function dictationLanguage(settings: Record<string, unknown>): string | undefined {
  const l = str(settings.sttLanguage);
  return l && l !== 'auto' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l) ? l : undefined;
}

/** The transcription session OpenAI mints a secret for (dictation.rs openai_session). */
export function openaiTranscriptionSession(model: string, language?: string): Record<string, unknown> {
  const live = model.includes('live');
  const transcription: Record<string, unknown> = { model };
  if (language) transcription[live ? 'languages' : 'language'] = live ? [language] : language;
  return {
    type: 'transcription',
    audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription,
      turn_detection: live ? null : { type: 'server_vad', silence_duration_ms: 600 },
    } },
  };
}

export function transcriptionUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '').replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  return `${b}/realtime?intent=transcription`;
}

async function mintDictation(engine: DictationEngine, keys: Keys, language: string | undefined, signal?: AbortSignal): Promise<Minted & { model: string }> {
  const f = doFetch ?? fetch;
  const model = DICTATION_DEFAULTS[engine].model;
  if (engine === 'openai') {
    const key = keys.openai!;
    const res = await f(`${key.baseUrl.replace(/\/+$/, '')}/realtime/client_secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: DICTATION_SECRET_SECONDS }, session: openaiTranscriptionSession(model, language) }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI didn't issue a dictation token (${await errorText(res)})`);
    const body = (await res.json()) as { value?: unknown; expires_at?: unknown };
    if (typeof body.value !== 'string' || !body.value) throw new Error("OpenAI didn't return a dictation token");
    const expires = typeof body.expires_at === 'number' ? body.expires_at * 1000 : Date.now() + DICTATION_SECRET_SECONDS * 1000;
    return { token: body.value, expiresAt: new Date(expires).toISOString(), url: transcriptionUrl(key.baseUrl), model };
  }
  if (engine === 'gemini') {
    // Single use, short to start; the setup is locked to transcription only, so the token can't
    // be used for a conversation.
    const now = Date.now();
    const expireTime = new Date(now + GEMINI_TOKEN_SECONDS * 1000).toISOString();
    const res = await f(`${GEMINI_BASE}/auth_tokens`, {
      method: 'POST',
      headers: { 'x-goog-api-key': keys.gemini!.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uses: 1, expireTime, newSessionExpireTime: new Date(now + GEMINI_START_SECONDS * 1000).toISOString(),
        bidiGenerateContentSetup: geminiDictationSetup(model),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Gemini didn't issue a dictation token (${await errorText(res)})`);
    const body = (await res.json()) as { name?: unknown; expireTime?: unknown };
    if (typeof body.name !== 'string' || !body.name) throw new Error("Gemini didn't return a dictation token");
    return { token: body.name, expiresAt: typeof body.expireTime === 'string' ? body.expireTime : expireTime, model };
  }
  if (engine === 'deepgram') {
    const res = await f(`${DEEPGRAM_BASE}/auth/grant`, {
      method: 'POST',
      headers: { Authorization: `Token ${keys.deepgram!.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: DEEPGRAM_TOKEN_SECONDS }),
      signal,
    });
    if (!res.ok) throw new Error(`Deepgram didn't issue a dictation token (${await errorText(res)})`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error("Deepgram didn't return a dictation token");
    const secs = typeof body.expires_in === 'number' ? body.expires_in : DEEPGRAM_TOKEN_SECONDS;
    return { token: body.access_token, expiresAt: new Date(Date.now() + secs * 1000).toISOString(), model };
  }
  const res = await f(`${ELEVENLABS_BASE}/single-use-token/realtime_scribe`, {
    method: 'POST',
    headers: { 'xi-api-key': keys.elevenlabs!.apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`ElevenLabs didn't issue a dictation token (${await errorText(res)})`);
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error("ElevenLabs didn't return a dictation token");
  return { token: body.token, expiresAt: new Date(Date.now() + ELEVENLABS_TOKEN_SECONDS * 1000).toISOString(), model };
}

const mobileVoice = new Hono();

/** What the phone shows on the call button and the dictation mic (and Settings → Voice): read live, so a newly saved key counts at once. */
export const ENGINE_NAMES: Record<MobileVoiceEngine | DictationEngine, string> = {
  openai: 'OpenAI', gemini: 'Gemini Live', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs Scribe',
};
/** "Listening · Gemini" on the phone's mic. */
const DICTATION_NAMES: Record<DictationEngine, string> = { ...ENGINE_NAMES, gemini: 'Gemini' };

export interface VoiceCapabilities {
  call: boolean;
  callEngine?: MobileVoiceEngine;
  callEngineName?: string;
  callSetup?: string;
  dictation: boolean;
  dictationEngine?: DictationEngine;
  dictationEngineName?: string;
  dictationSetup?: string;
  /** No speech service: the phone dictates with its own speech recognition. */
  dictationFallback?: 'device';
}

export function voiceCapabilities(): VoiceCapabilities {
  const keys = availableKeys();
  const settings = voiceSettings();
  const call = pickEngine(keys, settings);
  const dictation = pickDictationEngine(keys, settings);
  return {
    call: !!call,
    ...(call ? { callEngine: call, callEngineName: call === 'openai' ? 'OpenAI Realtime' : ENGINE_NAMES[call] } : { callSetup: NO_REALTIME_VOICE }),
    dictation: !!dictation,
    ...(dictation ? { dictationEngine: dictation, dictationEngineName: DICTATION_NAMES[dictation] } : { dictationSetup: DICTATION_SETUP, dictationFallback: 'device' as const }),
  };
}

mobileVoice.get('/api/mobile/voice/capabilities', (c) => c.json(voiceCapabilities(), 200, { 'Cache-Control': 'no-store' }));

mobileVoice.post('/api/mobile/voice/dictation', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { engine?: unknown };
  const keys = availableKeys();
  const settings = voiceSettings();
  const engine = pickDictationEngine(keys, settings, str(body.engine));
  if (!engine) return c.json({ error: DICTATION_SETUP, fallback: true, device: true, setup: DICTATION_SETUP }, 409);
  const language = dictationLanguage(settings);
  try {
    const m = await mintDictation(engine, keys, language, c.req.raw.signal);
    return c.json({
      engine, token: m.token, ephemeral: true, expiresAt: m.expiresAt, model: m.model,
      ...(m.url ? { url: m.url } : {}), ...(language ? { language } : {}),
    }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, fallback: true, engine, setup: `Live dictation couldn't start: ${message}` }, 409);
  }
});

mobileVoice.post('/api/mobile/voice/session', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { engine?: unknown };
  const keys = availableKeys();
  const settings = voiceSettings();
  const engine = pickEngine(keys, settings, str(body.engine));
  if (!engine) return c.json({ error: NO_REALTIME_VOICE, fallback: true }, 409);
  const signal = c.req.raw.signal;
  try {
    if (engine === 'openai') {
      const model = str(settings.voiceModel) ?? VOICE_DEFAULTS.openai.model;
      const voice = str(settings.voice) ?? VOICE_DEFAULTS.openai.voice;
      const m = await mintOpenAI(keys.openai!, model, voice, signal);
      return c.json({ engine, token: m.token, ephemeral: true, expiresAt: m.expiresAt, model, voice, url: m.url, instructions: phoneInstructions(), tools: PHONE_VOICE_TOOLS }, 200, { 'Cache-Control': 'no-store' });
    }
    const model = str(settings.geminiModel) ?? VOICE_DEFAULTS.gemini.model;
    const voice = str(settings.geminiVoice) ?? VOICE_DEFAULTS.gemini.voice;
    const m = await mintGemini(keys.gemini!, signal);
    return c.json({ engine, token: m.token, ephemeral: true, expiresAt: m.expiresAt, model, voice, instructions: phoneInstructions(), tools: PHONE_VOICE_TOOLS }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, fallback: true, engine }, 409);
  }
});

export default mobileVoice;
