import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-mobile-dictation-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import mobileVoice, {
  DICTATION_SETUP, dictationLanguage, openaiTranscriptionSession, pickDictationEngine, redactKeys, setMobileVoiceFetch, transcriptionUrl,
} from './mobile-voice.js';

const OPENAI_KEY = 'sk-test-openai-000000000000';
const DEEPGRAM_KEY = '0123456789abcdef0123456789abcdef01234567';
const post = (body: unknown = {}) => mobileVoice.request('http://127.0.0.1/api/mobile/voice/dictation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const capabilities = async () => (await mobileVoice.request('http://127.0.0.1/api/mobile/voice/capabilities')).json() as Promise<Record<string, unknown>>;
const withOpenAI = () => writeFileSync(join(home, 'mercury.yaml'), [
  'identity:', '  owner: Test', 'providers:', '  openai:', '    name: openai', `    apiKey: ${OPENAI_KEY}`, '    baseUrl: https://api.openai.com/v1', '    model: gpt-4o-mini', '    enabled: true', '',
].join('\n'));
const chooseVoice = (values: Record<string, string>) => {
  mkdirSync(join(home, 'plugins', 'optimus'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'optimus', 'settings.json'), JSON.stringify({ settingsVersion: 1, values }));
};
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  setMobileVoiceFetch(undefined);
  for (const k of ['GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  rmSync(join(home, 'plugins'), { recursive: true, force: true });
  writeFileSync(join(home, 'mercury.yaml'), 'identity:\n  owner: Test\n');
});

describe('GET /api/mobile/voice/capabilities', () => {
  it('with no keys: no call, no dictation, and what to add', async () => {
    const c = await capabilities();
    expect(c).toMatchObject({ call: false, dictation: false, dictationSetup: DICTATION_SETUP });
    expect(c.callSetup).toContain('OpenAI key');
  });

  it('Gemini only: calls yes, dictation no, and says why', async () => {
    process.env.GEMINI_API_KEY = 'AIza-test';
    const c = await capabilities();
    expect(c).toMatchObject({ call: true, callEngine: 'gemini', dictation: false });
    expect(c.dictationSetup).toContain("Gemini can't do it");
  });

  it('OpenAI: both, without calling any provider', async () => {
    withOpenAI();
    const f = vi.fn();
    setMobileVoiceFetch(f as never);
    expect(await capabilities()).toEqual({ call: true, callEngine: 'openai', dictation: true, dictationEngine: 'openai' });
    expect(f).not.toHaveBeenCalled();
  });

  it('Deepgram only: dictation yes, calls no', async () => {
    process.env.DEEPGRAM_API_KEY = DEEPGRAM_KEY;
    expect(await capabilities()).toMatchObject({ call: false, dictation: true, dictationEngine: 'deepgram' });
  });
});

describe('POST /api/mobile/voice/dictation', () => {
  it('with no speech key: 409 with the setup line', async () => {
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: DICTATION_SETUP, fallback: true, setup: DICTATION_SETUP });
  });

  it('mints an OpenAI transcription client secret; the key never leaves the server', async () => {
    withOpenAI();
    const f = vi.fn().mockResolvedValue(reply(200, { value: 'ek_dict', expires_at: 1_900_000_000 }));
    setMobileVoiceFetch(f as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(JSON.parse(text)).toEqual({
      engine: 'openai', token: 'ek_dict', ephemeral: true, expiresAt: new Date(1_900_000_000_000).toISOString(),
      model: 'gpt-live-transcribe', url: 'wss://api.openai.com/v1/realtime?intent=transcription',
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(init.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      expires_after: { anchor: 'created_at', seconds: 300 },
      session: { type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe' }, turn_detection: null,
      } } },
    });
  });

  it('uses the owner\'s listening choice: a Deepgram temporary token, with their language', async () => {
    withOpenAI();
    process.env.DEEPGRAM_API_KEY = DEEPGRAM_KEY;
    chooseVoice({ voiceEngine: 'mercury', sttProvider: 'deepgram', sttLanguage: 'hi' });
    const f = vi.fn().mockResolvedValue(reply(200, { access_token: 'jwt.abc', expires_in: 60 }));
    setMobileVoiceFetch(f as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ engine: 'deepgram', token: 'jwt.abc', ephemeral: true, model: 'nova-3', language: 'hi' });
    expect(body.url).toBeUndefined();
    expect(Date.parse(body.expiresAt as string)).toBeGreaterThan(Date.now());
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant');
    expect(init.headers.Authorization).toBe(`Token ${DEEPGRAM_KEY}`);
    expect(JSON.parse(init.body)).toEqual({ ttl_seconds: 60 });
  });

  it('mints an ElevenLabs single-use Scribe token when asked', async () => {
    withOpenAI();
    process.env.ELEVENLABS_API_KEY = 'sk_eleven_test_key';
    const f = vi.fn().mockResolvedValue(reply(200, { token: 'sutkn_1' }));
    setMobileVoiceFetch(f as never);
    const body = (await (await post({ engine: 'elevenlabs' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ engine: 'elevenlabs', token: 'sutkn_1', model: 'scribe_v2_realtime' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    expect(init.headers['xi-api-key']).toBe('sk_eleven_test_key');
  });

  it('a refused mint is a 409 with a plain reason and no key in it', async () => {
    process.env.DEEPGRAM_API_KEY = DEEPGRAM_KEY;
    setMobileVoiceFetch(vi.fn().mockResolvedValue(reply(401, { err_code: 'INVALID_AUTH', err_msg: `Invalid credentials ${DEEPGRAM_KEY}` })) as never);
    const res = await post();
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ fallback: true, engine: 'deepgram' });
    expect(body.error).toContain("Deepgram didn't issue a dictation token (401: Invalid credentials");
    expect(body.setup).toContain("Live dictation couldn't start");
    expect(JSON.stringify(body)).not.toContain(DEEPGRAM_KEY);
  });
});

describe('dictation choices', () => {
  const all = { openai: { apiKey: 'k', baseUrl: 'b' }, gemini: { apiKey: 'g' }, deepgram: { apiKey: 'd' }, elevenlabs: { apiKey: 'e' } };
  it('asked, then the owner\'s listener, then OpenAI, Deepgram, ElevenLabs; never Gemini', () => {
    expect(pickDictationEngine(all, {}, 'deepgram')).toBe('deepgram');
    expect(pickDictationEngine(all, { voiceEngine: 'mercury', sttProvider: 'elevenlabs' })).toBe('elevenlabs');
    expect(pickDictationEngine(all, { voiceEngine: 'mercury' })).toBe('deepgram');
    expect(pickDictationEngine(all, { voiceEngine: 'gemini' })).toBe('openai');
    expect(pickDictationEngine({ elevenlabs: { apiKey: 'e' } }, {}, 'openai')).toBe('elevenlabs');
    expect(pickDictationEngine({ gemini: { apiKey: 'g' } }, { voiceEngine: 'gemini' }, 'gemini')).toBeNull();
  });

  it('language: a code from Settings → Voice, never auto or junk', () => {
    expect(dictationLanguage({ sttLanguage: 'en' })).toBe('en');
    expect(dictationLanguage({ sttLanguage: 'hi-IN' })).toBe('hi-IN');
    expect(dictationLanguage({ sttLanguage: 'auto' })).toBeUndefined();
    expect(dictationLanguage({ sttLanguage: 'en&x=1' })).toBeUndefined();
  });

  it('OpenAI session shapes match the Rust engine', () => {
    expect(openaiTranscriptionSession('gpt-live-transcribe', 'en')).toMatchObject({ audio: { input: { transcription: { languages: ['en'] }, turn_detection: null } } });
    expect(openaiTranscriptionSession('gpt-4o-transcribe', 'en')).toMatchObject({ audio: { input: { transcription: { language: 'en' }, turn_detection: { type: 'server_vad' } } } });
    expect(transcriptionUrl('https://example.com/v1/')).toBe('wss://example.com/v1/realtime?intent=transcription');
  });

  it('redacts ElevenLabs and Deepgram keys too', () => {
    expect(redactKeys(`bad sk_abcdef1234 and ${DEEPGRAM_KEY}`)).toBe('bad sk_… and …');
  });
});
