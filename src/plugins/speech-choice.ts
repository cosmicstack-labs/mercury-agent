import { loadConfig } from '../utils/config.js';
import { readSettings, secretValue } from './store.js';
import { pickSpeechEngine, preferredSpeech, type SpeechEngine } from './transcribe.js';

/**
 * The speech service Mercury uses right now, for every feature that
 * listens (voice typing, voice notes) or speaks (reading replies aloud):
 * the voice the owner chose in Settings → Voice when it has a key, else the
 * first service that has one. Read on each use, so a change applies at once.
 */
export function currentSpeechEngine(use: 'listen' | 'speak'): SpeechEngine | null {
  let voice: Record<string, unknown> = {};
  try { voice = readSettings('optimus'); } catch { /* no Optimus settings: no preference */ }
  return pickSpeechEngine(loadConfig().providers.openai, secretValue, preferredSpeech(voice, use));
}

/** What to tell someone with no speech service yet. */
export const NO_SPEECH_SERVICE =
  'a speech service: an OpenAI key (Settings → Models), or a Gemini, Deepgram or ElevenLabs key (Settings → Voice).';
