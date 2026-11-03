import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-speak-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import speak, { setSpeakFetch } from './speak.js';

const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 1, 2, 3]);
const audioReply = () => ({ ok: true, status: 200, arrayBuffer: async () => mp3.buffer.slice(0) });
const post = (text: unknown) => speak.request('http://127.0.0.1/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
const withOpenAI = () => writeFileSync(join(home, 'mercury.yaml'), [
  'identity:', '  owner: Test', 'providers:', '  openai:', '    name: openai', '    apiKey: sk-test-openai-000000000000', '    baseUrl: https://api.openai.com/v1', '    model: gpt-4o-mini', '    enabled: true', '',
].join('\n'));

afterEach(() => {
  setSpeakFetch(undefined);
  delete process.env.DEEPGRAM_API_KEY; delete process.env.ELEVENLABS_API_KEY; delete process.env.GEMINI_API_KEY;
  rmSync(join(home, 'plugins'), { recursive: true, force: true });
  writeFileSync(join(home, 'mercury.yaml'), 'identity:\n  owner: Test\n');
});

/** Settings → Voice: what the owner picked for Optimus's voice. */
const chooseVoice = (values: Record<string, string>) => {
  mkdirSync(join(home, 'plugins', 'optimus'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'optimus', 'settings.json'), JSON.stringify({ settingsVersion: 1, values }));
};
const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2]);
const geminiReply = (bytes: Uint8Array, mimeType = 'audio/wav') => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } }] } }] }),
});

describe('read aloud', () => {
  it('with no speech service, says how to turn one on', async () => {
    expect(await (await speak.request('http://127.0.0.1/api/speak')).json()).toEqual({ available: false, engine: null, maxChars: 4000 });
    const res = await post('Hello');
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ needs: 'speech' });
  });

  it('speaks with the OpenAI provider and returns MP3', async () => {
    withOpenAI();
    const f = vi.fn().mockResolvedValue(audioReply());
    setSpeakFetch(f as never);
    const res = await post('The weather is sunny.');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(mp3);
    expect(f.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'The weather is sunny.', response_format: 'mp3' });
  });

  it('falls back to tts-1 on an endpoint without the newer model', async () => {
    withOpenAI();
    const f = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }).mockResolvedValueOnce(audioReply());
    setSpeakFetch(f as never);
    expect((await post('Hi')).status).toBe(200);
    expect(JSON.parse(f.mock.calls[1][1].body).model).toBe('tts-1');
  });

  it('uses a Deepgram or ElevenLabs voice key when there is no OpenAI', async () => {
    writeFileSync(join(home, 'mercury.yaml'), 'identity:\n  owner: Test\n');
    process.env.ELEVENLABS_API_KEY = 'el-key';
    const f = vi.fn().mockResolvedValue(audioReply());
    setSpeakFetch(f as never);
    expect((await post('Hi there')).status).toBe(200);
    expect(f.mock.calls[0][0]).toContain('api.elevenlabs.io/v1/text-to-speech/');
    expect(f.mock.calls[0][1].headers['xi-api-key']).toBe('el-key');

    process.env.DEEPGRAM_API_KEY = 'dg-key';
    expect((await post('Hi there')).status).toBe(200);
    expect(f.mock.calls[1][0]).toContain('api.deepgram.com/v1/speak');
    expect(f.mock.calls[1][1].headers.Authorization).toBe('Token dg-key');
  });

  it('refuses empty or oversized text, and a rejected key reads plainly', async () => {
    withOpenAI();
    expect((await post('  ')).status).toBe(400);
    expect((await post('x'.repeat(4001))).status).toBe(413);
    setSpeakFetch(vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }) as never);
    const res = await post('Hello');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/rejected the key/) });
  });

  it('speaks with a Gemini key and returns WAV', async () => {
    process.env.GEMINI_API_KEY = 'gm-test-key';
    const f = vi.fn().mockResolvedValue(geminiReply(wav));
    setSpeakFetch(f as never);
    expect(await (await speak.request('http://127.0.0.1/api/speak')).json()).toMatchObject({ available: true, engine: 'Gemini' });
    const res = await post('Hello from Mercury.');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(wav);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-[^:]+tts:generateContent$/);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gm-test-key');
    expect(JSON.parse(String(init.body)).generationConfig.responseModalities).toEqual(['AUDIO']);
  });

  it('raw PCM from Gemini gets a WAV header', async () => {
    process.env.GEMINI_API_KEY = 'gm-test-key';
    setSpeakFetch(vi.fn().mockResolvedValue(geminiReply(new Uint8Array([1, 2, 3, 4]), 'audio/L16;codec=pcm;rate=24000')) as never);
    const bytes = new Uint8Array(await (await post('Hi')).arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 4)).toString('latin1')).toBe('RIFF');
    expect(Buffer.from(bytes).readUInt32LE(24)).toBe(24000);
    expect(bytes.byteLength).toBe(44 + 4);
  });

  it('the voice chosen in Settings → Voice comes first: Gemini over OpenAI', async () => {
    withOpenAI();
    process.env.GEMINI_API_KEY = 'gm-test-key';
    chooseVoice({ voiceEngine: 'gemini' });
    expect(await (await speak.request('http://127.0.0.1/api/speak')).json()).toMatchObject({ engine: 'Gemini' });
    chooseVoice({ voiceEngine: 'openai' });
    expect(await (await speak.request('http://127.0.0.1/api/speak')).json()).toMatchObject({ engine: 'OpenAI' });
  });

  it('a chosen voice without a key falls back to one that has a key', async () => {
    process.env.GEMINI_API_KEY = 'gm-test-key';
    chooseVoice({ voiceEngine: 'openai' });
    expect(await (await speak.request('http://127.0.0.1/api/speak')).json()).toMatchObject({ engine: 'Gemini' });
  });

  it('says Gemini is an option when nothing is set up', async () => {
    const res = await post('Hello');
    expect(((await res.json()) as { error: string }).error).toMatch(/Gemini/);
  });
});
