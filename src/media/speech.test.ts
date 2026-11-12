import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mercury.yaml's path is fixed when config.ts loads: point Mercury at an empty
// home before anything imports it, so no real key (or request) is ever used.
const fixedHome = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-speech-home-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});
import { isSpeechModelEntry, listSpeechModels, resetMediaCatalogCache, type MediaSource } from './catalog.js';
import { loadMediaPrefs, resetMediaPrefsCache, setSpeechPrefs } from './prefs.js';
import { speakableText, SpeechService, toOggOpus, voiceReplyWanted } from './speech.js';
import { synthesizeSpeech } from '../plugins/speak.js';
import { applyMediaIntent, parseSayCommand } from './intent.js';
import { mediaCommand } from '../core/commands/chat-command.js';
import { MediaService } from './service.js';

/**
 * Speaking (ADR-042 phase 2): one choice of speech service and voice, found
 * on the owner's providers or keys, voice notes as Ogg/Opus, and replies
 * as voice notes when asked.
 */
let home: string;
const noNetwork = (async () => { throw new Error('network is off in this test'); }) as unknown as typeof fetch;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-speech-'));
  process.env.MERCURY_HOME = fixedHome;
  rmSync(join(fixedHome, 'media-prefs.json'), { force: true });
  rmSync(join(fixedHome, 'media-models.json'), { force: true });
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  resetMediaCatalogCache();
  resetMediaPrefsCache();
});
afterEach(() => {
  resetMediaCatalogCache();
  resetMediaPrefsCache();
  delete process.env.DEEPGRAM_API_KEY;
  rmSync(home, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 1, 2, 3]);
const src = (name: string, baseUrl: string): MediaSource => ({ name, baseUrl, endpoint: async () => ({ baseUrl, headers: { Authorization: 'Bearer cloud-jwt', 'X-Agent-Id': 'a1' } }) });

describe('finding speech models', () => {
  it('by output, type or name; never transcription or realtime models', () => {
    expect(isSpeechModelEntry({ id: 'tts-1' })).toBe(true);
    expect(isSpeechModelEntry({ id: 'gpt-4o-mini-tts' })).toBe(true);
    expect(isSpeechModelEntry({ id: 'kokoro-82m' })).toBe(true);
    expect(isSpeechModelEntry({ id: 'x', output_modalities: ['speech'] })).toBe(true);
    expect(isSpeechModelEntry({ id: 'y', type: 'text-to-speech' })).toBe(true);
    expect(isSpeechModelEntry({ id: 'gpt-4o-mini-transcribe' })).toBe(false);
    expect(isSpeechModelEntry({ id: 'whisper-1' })).toBe(false);
    expect(isSpeechModelEntry({ id: 'gpt-4o-audio-preview' })).toBe(false);
    expect(isSpeechModelEntry({ id: 'gpt-4.1' })).toBe(false);
  });

  it('LiteLLM mode audio_speech; others from /models', async () => {
    const litellm = (async () => json({ data: [{ model_name: 'voice', model_info: { mode: 'audio_speech' } }, { model_name: 'c', model_info: { mode: 'chat' } }] })) as unknown as typeof fetch;
    expect((await listSpeechModels(src('litellm', 'http://p/v1'), litellm))?.map((m) => m.ref)).toEqual(['litellm::voice']);
    const openai = (async () => json({ data: [{ id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-mini-tts-2025-03-20' }, { id: 'gpt-5' }] })) as unknown as typeof fetch;
    expect((await listSpeechModels(src('openai', 'http://o/v1'), openai))?.map((m) => m.model)).toEqual(['tts-1', 'gpt-4o-mini-tts']);
  });
});

describe('what speaks', () => {
  function service(fetchImpl: typeof fetch) {
    return new SpeechService(() => [src('mercuryCloud', 'https://backend/v1')], fetchImpl);
  }

  it('nothing set up: a clear error', async () => {
    await expect(service(noNetwork).speak('hi')).rejects.toThrow(/No speech service is set up/);
  });

  it("a provider's speech model: its endpoint, auth, model and the chosen voice; Ogg/Opus for a voice note", async () => {
    let url = '';
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fake = (async (u: string, init?: RequestInit) => {
      url = u; headers = init?.headers as Record<string, string>; body = JSON.parse(String(init?.body));
      return new Response(MP3);
    }) as unknown as typeof fetch;
    setSpeechPrefs({ choice: 'mercuryCloud::voice-1' });
    setSpeechPrefs({ voice: 'nova' });
    const s = service(fake);
    const out = await s.speak('Hello there', { format: 'ogg', instructions: 'warm' });
    expect(url).toBe('https://backend/v1/audio/speech');
    expect(headers.Authorization).toBe('Bearer cloud-jwt');
    expect(headers['X-Agent-Id']).toBe('a1');
    expect(body).toEqual({ model: 'voice-1', voice: 'nova', input: 'Hello there', response_format: 'opus', instructions: 'warm' });
    expect(out.mime).toBe('audio/ogg');
    expect(out.ext).toBe('ogg');
  });

  it('a direct service key (Deepgram) chosen, and saved to a file', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-key';
    let url = '';
    const fake = (async (u: string) => { url = u; return new Response(MP3); }) as unknown as typeof fetch;
    setSpeechPrefs({ choice: 'deepgram' });
    const s = service(fake);
    expect((await s.options()).map((o) => o.id)).toContain('deepgram');
    const { file, label } = await s.speakToFile('Good morning, team!', join(home, 'out'), { format: 'ogg', voice: 'aura-2-orion-en' });
    expect(url).toContain('model=aura-2-orion-en');
    expect(url).toContain('encoding=opus&container=ogg');
    expect(label).toBe('Deepgram');
    expect(file).toBe(join(home, 'out', 'good-morning-team.ogg'));
    expect(readFileSync(file)).toEqual(Buffer.from(MP3));
  });

  it('a choice that is no longer there falls back to Settings → Voice', async () => {
    setSpeechPrefs({ choice: 'elevenlabs' });
    expect(await service(noNetwork).target()).toBeNull();
  });

  it('prefs: a new service clears the voice; bad values are refused', () => {
    setSpeechPrefs({ choice: 'gemini' });
    setSpeechPrefs({ voice: 'Kore' });
    setSpeechPrefs({ choice: 'openai' });
    expect(loadMediaPrefs().speech).toEqual({ choice: 'openai' });
    expect(() => setSpeechPrefs({ choice: 'nonsense' })).toThrow();
    expect(() => setSpeechPrefs({ replies: 'sometimes' as never })).toThrow();
    setSpeechPrefs({ replies: 'always' });
    resetMediaPrefsCache();
    expect(loadMediaPrefs().speech?.replies).toBe('always');
  });
});

describe('the speech services themselves', () => {
  it('Gemini takes the style as words in front, and the chosen voice', async () => {
    let body: { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } } } | undefined;
    const fake = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('RIFFxxxxWAVE').toString('base64') } }] } }] });
    }) as unknown as typeof fetch;
    await synthesizeSpeech('Hello', { kind: 'gemini', label: 'Gemini', apiKey: 'g' }, { fetch: fake, voice: 'Puck', instructions: 'cheerfully.' });
    expect(body?.contents[0].parts[0].text).toBe('Say cheerfully: Hello');
    expect(body?.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
  });

  it('tts-1 never gets a style (it rejects the field)', async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(MP3); }) as unknown as typeof fetch;
    await synthesizeSpeech('Hi', { kind: 'openai', label: 'OpenAI', apiKey: 'k', model: 'tts-1' }, { fetch: fake, instructions: 'calm' });
    expect(body).not.toHaveProperty('instructions');
  });
});

describe('voice notes', () => {
  it('replies come as voice notes only in chat apps, by the setting', () => {
    expect(voiceReplyWanted('telegram', true)).toBe(true);
    expect(voiceReplyWanted('telegram', false)).toBe(false);
    expect(voiceReplyWanted('whatsapp', false, 'always')).toBe(true);
    expect(voiceReplyWanted('telegram', true, 'off')).toBe(false);
    expect(voiceReplyWanted('web', true, 'always')).toBe(false);
    expect(voiceReplyWanted('cli', true, 'always')).toBe(false);
  });

  it('what is said: no markdown or code, links by name, long replies cut at a sentence', () => {
    expect(speakableText('**Done.** See [the docs](https://x.y) and run:\n```sh\nnpm test\n```\n- one\n- two')).toBe('Done. See the docs and run:\n (code in the message) \none\ntwo');
    const long = speakableText(`${'This is a sentence. '.repeat(200)}`, 300);
    expect(long.length).toBeLessThan(340);
    expect(long.endsWith('The rest is in the message.')).toBe(true);
  });

  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasFfmpeg)('mp3 or wav becomes Ogg/Opus with ffmpeg', async () => {
    const dir = join(home, 'ff');
    mkdirSync(dir);
    const wav = join(dir, 'a.wav');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', wav]);
    const ogg = await toOggOpus(readFileSync(wav), 'wav');
    expect(ogg && Buffer.from(ogg.subarray(0, 4)).toString('ascii')).toBe('OggS');
  });

  it('ffmpeg missing or failing: null, so the audio goes as it was', async () => {
    expect(await toOggOpus(new Uint8Array([1, 2, 3]), 'mp3')).toBeNull();
  });
});

describe('/say and /media for speech', () => {
  it('parses /say with a style', () => {
    expect(parseSayCommand('/say --style "calm and slow" Good night')).toEqual({ text: 'Good night', style: 'calm and slow' });
    expect(parseSayCommand('/tts hello')).toEqual({ text: 'hello' });
    expect(parseSayCommand('/say')).toBeNull();
    expect(parseSayCommand('/sayonara')).toBeNull();
  });

  it('routes /say to generate_speech with the exact words', () => {
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: '/say Happy birthday, Sam!' }];
    expect(applyMediaIntent({ channelType: 'telegram', metadata: {} } as never, '/say Happy birthday, Sam!', messages)).toEqual({ kind: 'speech', text: 'Happy birthday, Sam!' });
    expect(String(messages[1].content)).toContain('generate_speech');
    expect(String(messages[1].content)).toContain('"Happy birthday, Sam!"');
  });

  it('/media replies, voice and speech choices', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg';
    const speech = new SpeechService(() => [], noNetwork);
    const media = new MediaService({ sources: () => [], currentProvider: () => undefined });
    expect((await mediaCommand(media, 'replies always', speech)).text).toContain('on every reply');
    expect((await mediaCommand(media, 'speech 1', speech)).text).toContain('Deepgram');
    expect(loadMediaPrefs().speech?.choice).toBe('deepgram');
    expect((await mediaCommand(media, 'voice aura-2-orion-en', speech)).text).toContain('aura-2-orion-en');
    expect((await mediaCommand(media, 'replies sometimes', speech)).text).toContain('Usage');
    expect((await mediaCommand(media, 'speech auto', speech)).text).toContain('follows Settings → Voice');
  });
});
