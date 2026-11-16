import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-mobile-voice-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import mobileVoice, { pickEngine, phoneInstructions, PHONE_VOICE_TOOLS, realtimeUrl, redactKeys, setMobileVoiceFetch } from './mobile-voice.js';

const OPENAI_KEY = 'sk-test-openai-000000000000';
const post = (body: unknown = {}) => mobileVoice.request('http://127.0.0.1/api/mobile/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const withOpenAI = (baseUrl = 'https://api.openai.com/v1') => writeFileSync(join(home, 'mercury.yaml'), [
  'identity:', '  owner: Test', 'providers:', '  openai:', '    name: openai', `    apiKey: ${OPENAI_KEY}`, `    baseUrl: ${baseUrl}`, '    model: gpt-4o-mini', '    enabled: true', '',
].join('\n'));
const chooseVoice = (values: Record<string, string>) => {
  mkdirSync(join(home, 'plugins', 'optimus'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'optimus', 'settings.json'), JSON.stringify({ settingsVersion: 1, values }));
};
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  setMobileVoiceFetch(undefined);
  delete process.env.GEMINI_API_KEY;
  rmSync(join(home, 'plugins'), { recursive: true, force: true });
  writeFileSync(join(home, 'mercury.yaml'), 'identity:\n  owner: Test\n');
});

describe('POST /api/mobile/voice/session', () => {
  it('with no OpenAI or Gemini key, says so and tells the app to fall back', async () => {
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fallback: true, error: expect.stringContaining('OpenAI key') });
  });

  it('mints an OpenAI Realtime client secret; the key never leaves the server', async () => {
    withOpenAI();
    const f = vi.fn().mockResolvedValue(reply(200, { value: 'ek_abc', expires_at: 1_900_000_000 }));
    setMobileVoiceFetch(f as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      engine: 'openai', token: 'ek_abc', ephemeral: true, expiresAt: new Date(1_900_000_000_000).toISOString(),
      model: 'gpt-realtime-2.1', voice: 'marin', url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['ask_mercury', 'end_conversation', 'answer_approval']);
    expect(body.instructions).toContain('call ask_mercury');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(init.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: { type: 'realtime', model: 'gpt-realtime-2.1', audio: { output: { voice: 'marin' } } },
    });
  });

  it('uses the voice the owner chose for Optimus: Gemini Live with an ephemeral token', async () => {
    withOpenAI();
    process.env.GEMINI_API_KEY = 'AIza-test-gemini';
    chooseVoice({ voiceEngine: 'gemini', geminiVoice: 'Puck' });
    const f = vi.fn().mockResolvedValue(reply(200, { name: 'auth_tokens/xyz', expireTime: '2030-01-01T00:30:00Z' }));
    setMobileVoiceFetch(f as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ engine: 'gemini', token: 'auth_tokens/xyz', expiresAt: '2030-01-01T00:30:00Z', model: 'gemini-3.8-live', voice: 'Puck' });
    expect(body.url).toBeUndefined();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(init.headers['x-goog-api-key']).toBe('AIza-test-gemini');
    const sent = JSON.parse(init.body);
    expect(sent.uses).toBe(1);
    expect(Date.parse(sent.newSessionExpireTime)).toBeLessThan(Date.parse(sent.expireTime));
  });

  it('honours the OpenAI voice model and voice settings, and an engine the app asks for', async () => {
    withOpenAI();
    process.env.GEMINI_API_KEY = 'AIza-test-gemini';
    chooseVoice({ voiceEngine: 'gemini', voiceModel: 'gpt-realtime-mini', voice: 'cedar' });
    setMobileVoiceFetch(vi.fn().mockResolvedValue(reply(200, { value: 'ek_1', expires_at: 1_900_000_000 })) as never);
    expect(await (await post({ engine: 'openai' })).json()).toMatchObject({ engine: 'openai', model: 'gpt-realtime-mini', voice: 'cedar' });
  });

  it('a refused mint is a fallback with a plain reason and no key in it', async () => {
    withOpenAI();
    setMobileVoiceFetch(vi.fn().mockResolvedValue(reply(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } })) as never);
    const res = await post();
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ fallback: true, engine: 'openai' });
    expect(body.error).toContain("OpenAI didn't issue a voice token (401");
    expect(body.error).not.toContain('openai-000000000000');
  });
});

describe('engine choice', () => {
  const both = { openai: { apiKey: 'k', baseUrl: 'b' }, gemini: { apiKey: 'g' } };
  it('prefers what was asked, then the owner\'s voice engine, then OpenAI, then Gemini', () => {
    expect(pickEngine(both, { voiceEngine: 'openai' }, 'gemini')).toBe('gemini');
    expect(pickEngine(both, { voiceEngine: 'gemini' })).toBe('gemini');
    expect(pickEngine(both, { voiceEngine: 'grok' })).toBe('openai');
    expect(pickEngine({ gemini: { apiKey: 'g' } }, {})).toBe('gemini');
    expect(pickEngine({ gemini: { apiKey: 'g' } }, {}, 'openai')).toBe('gemini');
    expect(pickEngine({}, { voiceEngine: 'openai' })).toBeNull();
  });

  it('builds the Realtime URL from the provider base URL', () => {
    expect(realtimeUrl('https://example.com/v1/', 'm 1')).toBe('wss://example.com/v1/realtime?model=m%201');
  });

  it('adds Mercury\'s briefing after the phone instructions', () => {
    expect(phoneInstructions('You are Mercury, serving Test.')).toMatch(/end_conversation\.\n\nYou are Mercury, serving Test\.$/);
    expect(phoneInstructions('')).not.toMatch(/\n\n$/);
    expect(PHONE_VOICE_TOOLS[0].parameters).toEqual({ type: 'object', properties: { question: { type: 'string' } }, required: ['question'] });
  });

  it('never repeats a key in an error', () => {
    expect(redactKeys('bad key sk-proj-abcdef123 and AIzaSyXXXX1234')).toBe('bad key sk-… and AIza…');
  });
});
