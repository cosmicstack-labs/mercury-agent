import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-transcribe-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import transcribe, { setTranscribeFetch } from './transcribe.js';

const audio = new Uint8Array(4000).fill(7);
const post = (body: Uint8Array = audio, type = 'audio/webm;codecs=opus', q = '') =>
  transcribe.request(`http://127.0.0.1/api/transcribe${q}`, { method: 'POST', headers: { 'Content-Type': type }, body });
const withOpenAI = () => writeFileSync(join(home, 'mercury.yaml'), [
  'identity:', '  owner: Test', 'providers:', '  openai:', '    name: openai', '    apiKey: sk-test-openai-000000000000', '    baseUrl: https://api.openai.com/v1', '    model: gpt-4o-mini', '    enabled: true', '',
].join('\n'));

afterEach(() => { setTranscribeFetch(undefined); delete process.env.DEEPGRAM_API_KEY; });

describe('dictation', () => {
  it('with no speech service, says how to turn one on', async () => {
    expect(await (await transcribe.request('http://127.0.0.1/api/transcribe')).json()).toEqual({ available: false, engine: null });
    const res = await post();
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ needs: 'speech' });
  });

  it('falls back to a Deepgram voice key', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-key';
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'hello from deepgram' }] }] } }) });
    setTranscribeFetch(f as never);
    const body: unknown = await (await post()).json();
    expect(body).toEqual({ text: 'hello from deepgram', engine: 'Deepgram' });
    expect(f.mock.calls[0][0]).toContain('api.deepgram.com/v1/listen');
    expect(f.mock.calls[0][1].headers['Content-Type']).toBe('audio/webm');
  });

  it('prefers the OpenAI provider, sends the recording as a file, and passes the language', async () => {
    withOpenAI();
    process.env.DEEPGRAM_API_KEY = 'dg-key';
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: ' Remind me to call Heer. ' }) });
    setTranscribeFetch(f as never);
    const body: unknown = await (await post(audio, 'audio/mp4', '?language=en')).json();
    expect(body).toEqual({ text: 'Remind me to call Heer.', engine: 'OpenAI' });
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).name).toBe('dictation.m4a');
  });

  it('a rejected key and an empty recording read plainly', async () => {
    withOpenAI();
    setTranscribeFetch(vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }) as never);
    expect(await (await post()).json()).toMatchObject({ error: expect.stringMatching(/rejected the key/) });
    expect(await (await post(new Uint8Array(10))).json()).toMatchObject({ error: expect.stringMatching(/Didn't catch anything/) });
  });

  it('refuses non-audio bodies', async () => {
    withOpenAI();
    expect((await post(audio, 'application/json')).status).toBe(415);
  });
});
