/**
 * Media sources that aren't chat providers: API keys the owner saved for
 * voice (Settings → Voice). Gemini makes images, Omni video and Lyria
 * music; ElevenLabs makes music. Read on each use, so adding a key applies
 * at once.
 */
import { secretValue } from '../plugins/store.js';
import { ELEVENLABS_SOURCE, GEMINI_SOURCE, type MediaSource } from './catalog.js';

export function mediaKeySources(secret: (name: string) => string | undefined = secretValue): MediaSource[] {
  const out: MediaSource[] = [];
  const gemini = secret('GEMINI_API_KEY');
  if (gemini) {
    out.push({
      name: GEMINI_SOURCE,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      endpoint: async () => ({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', headers: { 'x-goog-api-key': gemini } }),
    });
  }
  const eleven = secret('ELEVENLABS_API_KEY');
  if (eleven) {
    out.push({
      name: ELEVENLABS_SOURCE,
      baseUrl: 'https://api.elevenlabs.io/v1',
      endpoint: async () => ({ baseUrl: 'https://api.elevenlabs.io/v1', headers: { 'xi-api-key': eleven } }),
    });
  }
  return out;
}
