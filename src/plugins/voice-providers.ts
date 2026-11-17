import { loadConfig } from '../utils/config.js';
import { readPluginKeys, readSettings, secretValue, setPluginKey } from './store.js';
import { checkVoiceKey, VOICE_KEY_ENV, VOICE_VENDORS, type VoiceVendor } from './voice-check.js';

/**
 * Voice providers, for Settings → Voice on every client (phone, Desktop), with
 * no plugin needed. There is ONE place voice keys live: Mercury's shared key
 * store (store.ts `setPluginKey` / `secretValue`: ~/.mercury/.env first, then
 * plugin-keys.json), under the env names the Optimus plugin declares as its
 * secrets (voice-check.ts VOICE_KEY_ENV). Optimus's own settings write the
 * same names to the same store, so a key saved here is Optimus's key and the
 * other way round. OpenAI is the exception: its key is the OpenAI model
 * provider's (Settings → Models), shown here but never edited here.
 *
 * Keys never leave the server: the list says whether a key is set, where it
 * comes from and its last four characters.
 */

export type VoiceUse = 'calls' | 'dictation' | 'optimus';
export type VoiceKeySource = 'env' | 'store' | 'provider';

export interface VoiceProviderInfo {
  id: string;
  name: string;
  /** The env name the key is stored under (shared with Optimus); null for OpenAI (the model provider's key). */
  env: string | null;
  /** What it's for: phone calls, dictation, the computer voice (Optimus). */
  uses: VoiceUse[];
  set: boolean;
  source: VoiceKeySource | null;
  /** The key's last four characters, when it's long enough not to give it away. */
  hint?: string;
  canEdit: boolean;
  /** Why it can't be edited here, or where to get a key. */
  note?: string;
}

export type VoiceProviderId = 'openai' | VoiceVendor;

const NAMES: Record<VoiceProviderId, string> = {
  openai: 'OpenAI', gemini: 'Google Gemini', elevenlabs: 'ElevenLabs', deepgram: 'Deepgram', assemblyai: 'AssemblyAI',
  cartesia: 'Cartesia', qwen: 'Alibaba Qwen (DashScope)', azure: 'Azure OpenAI', sarvam: 'Sarvam', minimax: 'MiniMax',
};

/** Phone calls: OpenAI Realtime, Gemini Live. Dictation: OpenAI, Deepgram, ElevenLabs (mobile-voice.ts). Every vendor here is one Optimus can use. */
const USES: Record<VoiceProviderId, VoiceUse[]> = {
  openai: ['calls', 'dictation', 'optimus'],
  gemini: ['calls', 'optimus'],
  deepgram: ['dictation', 'optimus'],
  elevenlabs: ['dictation', 'optimus'],
  assemblyai: ['optimus'], cartesia: ['optimus'], qwen: ['optimus'], azure: ['optimus'], sarvam: ['optimus'], minimax: ['optimus'],
};

const WHERE: Partial<Record<VoiceProviderId, string>> = {
  gemini: 'Get a key at aistudio.google.com/apikey.',
  elevenlabs: 'Get a key at elevenlabs.io → Developers → API keys.',
  deepgram: 'Get a key at console.deepgram.com.',
};

/** The order clients show them in: what the phone uses first. */
export const VOICE_PROVIDER_IDS: readonly VoiceProviderId[] = ['openai', 'gemini', 'elevenlabs', 'deepgram', ...VOICE_VENDORS.filter((v) => !['gemini', 'elevenlabs', 'deepgram'].includes(v))];

export function isEditableVoiceProvider(id: string): id is VoiceVendor {
  return (VOICE_VENDORS as readonly string[]).includes(id);
}

function hintOf(key: string): string | undefined {
  return key.length >= 12 ? key.slice(-4) : undefined;
}

function openaiInfo(): VoiceProviderInfo {
  let key: string | undefined;
  try {
    const p = loadConfig().providers.openai;
    if (p?.apiKey && p.enabled !== false) key = p.apiKey;
  } catch { /* no config */ }
  return {
    id: 'openai', name: NAMES.openai, env: null, uses: USES.openai, set: !!key, source: key ? 'provider' : null,
    ...(key ? { hint: hintOf(key) } : {}),
    canEdit: false,
    note: key ? 'From your OpenAI model. Change it in Settings → Models.' : 'Add an OpenAI key in Settings → Models.',
  };
}

export function voiceProviderInfo(id: VoiceProviderId): VoiceProviderInfo {
  if (id === 'openai') return openaiInfo();
  const env = VOICE_KEY_ENV[id];
  const fromEnv = process.env[env] || undefined;
  const fromStore = fromEnv ? undefined : readPluginKeys()[env];
  const key = fromEnv ?? fromStore;
  return {
    id, name: NAMES[id], env, uses: USES[id], set: !!key, source: fromEnv ? 'env' : fromStore ? 'store' : null,
    ...(key ? { hint: hintOf(key) } : {}),
    canEdit: !fromEnv,
    ...(fromEnv ? { note: `Set on the computer (${env} in ~/.mercury/.env). Change it there.` } : WHERE[id] ? { note: WHERE[id] } : {}),
  };
}

export function listVoiceProviders(): VoiceProviderInfo[] {
  return VOICE_PROVIDER_IDS.map(voiceProviderInfo);
}

/** A light format check before anything is sent anywhere. Null = looks fine. */
export function keyFormatProblem(key: string): string | null {
  if (!key) return 'Paste a key.';
  if (/\s/.test(key) || key.includes('•') || key.includes('…')) return 'Paste the full key, with no spaces.';
  if (key.length < 8) return "That doesn't look like an API key.";
  if (key.length > 512) return 'That key is too long.';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'That key has characters an API key never has.';
  return null;
}

type Fetch = typeof fetch;
let checkFetch: Fetch | undefined;
/** Test seam. */
export function setVoiceProviderFetch(f: Fetch | undefined): void { checkFetch = f; }

export interface SaveResult {
  ok: boolean;
  /** true when the provider confirmed the key. */
  verified: boolean;
  error?: string;
  message?: string;
}

/**
 * Save (or with null, remove) a voice key in the shared store. Refuses a key
 * set in Mercury's environment (it would win anyway). Checks the key with the
 * provider first; a key the provider rejects is not saved, one that can't be
 * checked (no read-only endpoint, no network) is saved and says so.
 */
export async function saveVoiceKey(id: VoiceVendor, apiKey: string | null, opts: { verify?: boolean } = {}): Promise<SaveResult & { status: number }> {
  const env = VOICE_KEY_ENV[id];
  if (process.env[env]) {
    return { status: 409, ok: false, verified: false, error: `${NAMES[id]}'s key is set on the computer (${env} in ~/.mercury/.env), which always wins. Change or remove it there.` };
  }
  if (apiKey === null) {
    setPluginKey(env, null);
    return { status: 200, ok: true, verified: false, message: `${NAMES[id]} key removed.` };
  }
  const key = apiKey.trim();
  const bad = keyFormatProblem(key);
  if (bad) return { status: 400, ok: false, verified: false, error: bad };
  let verified = false;
  let message: string | undefined;
  if (opts.verify !== false) {
    let endpoint: string | undefined;
    if (id === 'azure') {
      try { endpoint = String(readSettings('optimus').azureEndpoint ?? '') || undefined; } catch { /* none */ }
    }
    const check = await checkVoiceKey(id, key, { endpoint, fetch: checkFetch });
    // A provider's error could quote the key: never pass it on.
    const scrub = (m: string): string => m.split(key).join('…');
    if (check.verified && !check.ok) return { status: 400, ok: false, verified: true, error: scrub(check.message) };
    verified = check.verified && check.ok;
    message = verified ? check.message : `Saved. ${NAMES[id]} couldn't check it right now, so it's checked the first time it's used.`;
  }
  setPluginKey(env, key);
  return { status: 200, ok: true, verified, ...(message ? { message } : {}) };
}

/** Exposed for tests and the routes: what Optimus would read for this provider right now. */
export function sharedKeyFor(id: VoiceVendor): string | undefined {
  return secretValue(VOICE_KEY_ENV[id]);
}
