import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real mercury.yaml must never be read: point Mercury at an empty home first.
const fixedHome = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-video-home-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { listGeminiModels, listMusicModels, listVideoModels, resetMediaCatalogCache } = await import('./catalog.js');
const { generateMusicWith, generateVideoWith } = await import('./video.js');
const { generateWith } = await import('./image.js');
const { MediaService } = await import('./service.js');
const { MediaJobs } = await import('./jobs.js');
const { parseJobCommand, applyMediaIntent } = await import('./intent.js');
const { mediaCommand } = await import('../core/commands/chat-command.js');
const { loadMediaPrefs, resetMediaPrefsCache } = await import('./prefs.js');
const { mediaKeySources } = await import('./key-sources.js');
const { Agent } = await import('../core/agent.js');
const { WebChannel } = await import('../channels/web.js');

/**
 * Video and music (ADR-042 phase 3): Gemini (Omni video, Lyria music,
 * Nano Banana images) and ElevenLabs Music from saved keys, the OpenAI
 * Videos API on gateways, and background jobs posted to the chat that asked.
 */
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-video-'));
  for (const f of ['media-models.json', 'media-prefs.json', 'media-jobs.json']) rmSync(join(fixedHome, f), { force: true });
  resetMediaCatalogCache();
  resetMediaPrefsCache();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MP4 = Buffer.from('....ftypmp42 fake video');
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 9, 9]);
const gemini = mediaKeySources((k) => (k === 'GEMINI_API_KEY' ? 'g-key' : undefined))[0];
const eleven = mediaKeySources((k) => (k === 'ELEVENLABS_API_KEY' ? 'e-key' : undefined))[0];
const GEMINI_MODELS = { models: [
  { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-omni-1.2-flash', displayName: 'Gemini Omni 1.2 Flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/lyria-3.5', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/lyria-realtime-exp', supportedGenerationMethods: ['bidiGenerateMusic'] },
  { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
] };

describe('what keys and gateways offer', () => {
  it('a Gemini key: images, Omni video and Lyria music (not the live stream)', async () => {
    const fake = (async () => json(GEMINI_MODELS)) as unknown as typeof fetch;
    const models = await listGeminiModels(gemini, fake);
    expect(models?.map((m) => [m.model, m.kind, m.backend])).toEqual([
      ['gemini-3.1-flash-image', 'image', 'gemini-image'],
      ['gemini-omni-1.2-flash', 'video', 'gemini-omni'],
      ['lyria-3.5', 'music', 'gemini-lyria'],
    ]);
    expect(models?.[1].label).toBe('Gemini Omni 1.2 Flash');
    expect(models?.[1].group).toBe('Gemini');
  });

  it('ElevenLabs: its music models; gateways: video by mode, output or name', async () => {
    expect((await listMusicModels(eleven))?.map((m) => m.model)).toEqual(['music_v2_5', 'music_v2', 'music_v1']);
    const litellm = (async () => json({ data: [{ model_name: 'veo', model_info: { mode: 'video_generation' } }] })) as unknown as typeof fetch;
    const src = { name: 'litellm', baseUrl: 'http://p/v1', endpoint: async () => ({ baseUrl: 'http://p/v1', headers: {} }) };
    expect((await listVideoModels(src, litellm))?.map((m) => [m.ref, m.backend])).toEqual([['litellm::veo', 'openai-videos']]);
    const other = (async () => json({ data: [{ id: 'kling-v2' }, { id: 'gpt-4.1' }, { id: 'x', output_modalities: ['video'] }] })) as unknown as typeof fetch;
    expect((await listVideoModels({ ...src, name: 'openaiCompat' }, other))?.map((m) => m.model)).toEqual(['kling-v2', 'x']);
  });
});

const model = (id: string, kind: 'image' | 'video' | 'music', backend: string) => ({ ref: `p::${id}`, provider: 'p', model: id, kind, backend: backend as never, label: id, group: 'P', canEdit: true });
const gemEp = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', headers: { 'x-goog-api-key': 'g' } };

describe('calling them', () => {
  it('Gemini Omni: Interactions with the video format; the inline MP4 is read back', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fake = (async (u: string, init?: RequestInit) => {
      url = u; body = JSON.parse(String(init?.body));
      return json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A cat surfing.' }, { type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') }] }] });
    }) as unknown as typeof fetch;
    const out = await generateVideoWith(model('gemini-omni-1.2-flash', 'video', 'gemini-omni'), gemEp, { prompt: 'a cat surfing', aspect: 'portrait', seconds: 30 }, fake);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(body).toEqual({ model: 'gemini-omni-1.2-flash', input: 'a cat surfing', response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '15s' } });
    expect(out.bytes.equals(MP4)).toBe(true);
    expect(out.note).toBe('A cat surfing.');
  });

  it('a reference image goes in with the prompt', async () => {
    const ref = join(home, 'still.png');
    writeFileSync(ref, Buffer.from([0x89, 0x50]));
    let body: { input?: unknown } = {};
    const fake = (async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4.toString('base64') }] }] }); }) as unknown as typeof fetch;
    await generateVideoWith(model('gemini-omni-1.2-flash', 'video', 'gemini-omni'), gemEp, { prompt: 'animate it', references: [ref] }, fake);
    expect(body.input).toEqual([{ type: 'text', text: 'animate it' }, { type: 'image', data: Buffer.from([0x89, 0x50]).toString('base64'), mime_type: 'image/png' }]);
  });

  it('OpenAI Videos API: start, poll until completed, download', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let polls = 0;
    const fake = (async (u: string) => {
      calls.push(u);
      if (u.endsWith('/videos')) return json({ id: 'v1', status: 'queued' });
      if (u.endsWith('/content')) return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
      polls++;
      return json({ id: 'v1', status: polls < 2 ? 'in_progress' : 'completed' });
    }) as unknown as typeof fetch;
    const run = generateVideoWith(model('veo', 'video', 'openai-videos'), { baseUrl: 'http://gw/v1', headers: {} }, { prompt: 'x' }, fake);
    await vi.advanceTimersByTimeAsync(11_000);
    const out = await run;
    vi.useRealTimers();
    expect(calls).toEqual(['http://gw/v1/videos', 'http://gw/v1/videos/v1', 'http://gw/v1/videos/v1', 'http://gw/v1/videos/v1/content']);
    expect(out.bytes.equals(MP4)).toBe(true);
  });

  it('a failed gateway job says why', async () => {
    const fake = (async (u: string) => (u.endsWith('/videos') ? json({ id: 'v1', status: 'failed', error: { message: 'policy' } }) : json({}))) as unknown as typeof fetch;
    await expect(generateVideoWith(model('veo', 'video', 'openai-videos'), { baseUrl: 'http://gw/v1', headers: {} }, { prompt: 'x' }, fake)).rejects.toThrow('The video job failed: policy');
  });

  it('Lyria: length and "instrumental" in the words, the revision header, MP3 back', async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fake = (async (_u: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>; body = JSON.parse(String(init?.body));
      return json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: MP3.toString('base64') }] }] });
    }) as unknown as typeof fetch;
    const out = await generateMusicWith(model('lyria-3.5', 'music', 'gemini-lyria'), gemEp, { prompt: 'lo-fi beat', seconds: 90, instrumental: true }, fake);
    expect(headers['Api-Revision']).toBe('2026-05-20');
    expect(body).toEqual({ model: 'lyria-3.5', input: 'lo-fi beat Instrumental only, no vocals. About 90 seconds long.' });
    expect(out).toMatchObject({ mime: 'audio/mpeg' });
    expect(out.bytes.equals(MP3)).toBe(true);
  });

  it('ElevenLabs Music: length in ms, instrumental, the model', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fake = (async (u: string, init?: RequestInit) => { url = u; body = JSON.parse(String(init?.body)); return new Response(MP3); }) as unknown as typeof fetch;
    await generateMusicWith(model('music_v2_5', 'music', 'elevenlabs-music'), { baseUrl: 'https://api.elevenlabs.io/v1', headers: { 'xi-api-key': 'e' } }, { prompt: 'jingle', seconds: 20, instrumental: true }, fake);
    expect(url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    expect(body).toEqual({ prompt: 'jingle', model_id: 'music_v2_5', music_length_ms: 20000, force_instrumental: true });
  });

  it('Gemini images: generateContent with image output and the aspect ratio', async () => {
    let url = '';
    let body: { generationConfig?: unknown } = {};
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fake = (async (u: string, init?: RequestInit) => {
      url = u; body = JSON.parse(String(init?.body));
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
    }) as unknown as typeof fetch;
    const out = await generateWith(model('gemini-3.1-flash-image', 'image', 'gemini-image'), gemEp, { prompt: 'fox', aspect: 'landscape' }, fake);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
    expect(out.images[0].bytes.equals(PNG)).toBe(true);
  });
});

describe('background jobs', () => {
  const chat = { channelType: 'telegram', channelId: 'telegram:1' };

  it('runs after the turn and is delivered once, done or failed', async () => {
    const delivered: Array<{ status: string; file?: string; error?: string }> = [];
    const jobs = new MediaJobs(async (j) => { delivered.push({ status: j.status, file: j.file, error: j.error }); }, join(home, 'jobs.json'));
    const ok = jobs.start('video', 'a fox', chat, async () => ({ file: '/out/fox.mp4', madeWith: 'Omni · Gemini' }));
    expect(ok.status).toBe('running');
    jobs.start('music', 'a song', chat, async () => { throw new Error('quota'); });
    await jobs.idle();
    expect(delivered).toEqual([{ status: 'done', file: '/out/fox.mp4', error: undefined }, { status: 'failed', file: undefined, error: 'quota' }]);
    expect(JSON.parse(readFileSync(join(home, 'jobs.json'), 'utf-8')).every((j: { delivered: boolean }) => j.delivered)).toBe(true);
  });

  it('a restart cuts running jobs off: their chats are told, once', async () => {
    writeFileSync(join(home, 'jobs.json'), JSON.stringify([{ id: 'a1', kind: 'video', prompt: 'x', status: 'running', chat, createdAt: 1, delivered: false }]));
    const delivered: string[] = [];
    const jobs = new MediaJobs(async (j) => { delivered.push(`${j.id}:${j.status}`); }, join(home, 'jobs.json'));
    expect(await jobs.recover()).toBe(1);
    expect(await jobs.recover()).toBe(0);
    expect(delivered).toEqual(['a1:failed']);
  });

  it('announces a started job (a placeholder appears) with its shape', async () => {
    const announced: string[] = [];
    const jobs = new MediaJobs(async () => {}, join(home, 'jobs.json'), (j) => announced.push(`${j.kind}:${j.aspect}`));
    jobs.start('video', 'x', chat, async () => ({ file: '/f.mp4', madeWith: 'm' }), { aspect: 'portrait' });
    await jobs.idle();
    expect(announced).toEqual(['video:portrait']);
  });

  it('stop aborts a chat’s running job', async () => {
    const delivered: string[] = [];
    const jobs = new MediaJobs(async (j) => { delivered.push(j.error ?? ''); }, join(home, 'jobs.json'));
    jobs.start('video', 'x', chat, (signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(jobs.stop({ channelId: 'telegram:2' })).toBe(0);
    expect(jobs.stop({ channelId: 'telegram:1' })).toBe(1);
    await jobs.idle();
    expect(delivered).toEqual(['Stopped.']);
  });
});

describe('asking for video and music', () => {
  it('/video and /music with flags', () => {
    expect(parseJobCommand('/video --portrait --seconds 6 a cat surfing')).toEqual({ kind: 'video', prompt: 'a cat surfing', aspect: 'portrait', seconds: 6 });
    expect(parseJobCommand('/music --instrumental lo-fi beat')).toEqual({ kind: 'music', prompt: 'lo-fi beat', instrumental: true });
    expect(parseJobCommand('/song happy birthday for Sam')).toEqual({ kind: 'music', prompt: 'happy birthday for Sam' });
    expect(parseJobCommand('/video')).toBeNull();
    expect(parseJobCommand('/videos of cats')).toBeNull();
  });

  it('routes to the background tool, from a command or the Create menu', () => {
    const m1: Array<{ role: string; content: unknown }> = [{ role: 'user', content: '/music lo-fi beat' }];
    applyMediaIntent({ channelType: 'telegram', metadata: {} } as never, '/music lo-fi beat', m1);
    expect(m1[0].content).toBe('lo-fi beat');
    expect(String(m1[1].content)).toContain('Call generate_music now');
    const m2: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'a drone shot of a coast' }];
    applyMediaIntent({ channelType: 'web', metadata: { media: { kind: 'video', aspect: 'portrait' } } } as never, 'a drone shot of a coast', m2);
    expect(String(m2[1].content)).toContain('Call generate_video now with aspect "portrait"');
  });

  it('/media lists video and music, and sets their defaults', async () => {
    const fake = (async () => json(GEMINI_MODELS)) as unknown as typeof fetch;
    const media = new MediaService({ sources: () => [gemini, eleven], currentProvider: () => undefined }, fake);
    const shown = (await mediaCommand(media, '')).text;
    expect(shown).toContain('**Video** · Gemini Omni 1.2 Flash · Gemini (automatic)');
    expect(shown).toContain('**Music** · Lyria 3.5');
    expect((await mediaCommand(media, 'music 2')).text).toContain('Eleven Music v2.5');
    expect(loadMediaPrefs().music?.primary).toBe('elevenlabs::music_v2_5');
  });
});

describe('posting a finished job to its chat', () => {
  function fakeAgent(channelType: string) {
    const sent: string[] = [];
    const files: string[] = [];
    const appended: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
    const ready: Array<{ text: string; artifacts: unknown[] }> = [];
    const channel = channelType === 'web'
      ? Object.assign(Object.create(WebChannel.prototype), { sendMediaReady: (text: string, artifacts: unknown[]) => ready.push({ text, artifacts }) })
      : { send: async (t: string) => { sent.push(t); }, sendFile: async (f: string) => { files.push(f); } };
    const self = { channels: { get: () => channel }, sessions: { appendMessage: (_id: string, m: { content: string; metadata?: Record<string, unknown> }) => { appended.push(m); } } };
    return { self, sent, files, appended, ready };
  }

  it('chat apps: a note, then the file', async () => {
    const file = join(home, 'fox.mp4');
    writeFileSync(file, MP4);
    const a = fakeAgent('telegram');
    await Agent.prototype.deliverMediaJob.call(a.self as never, { id: 'j', kind: 'video', prompt: 'fox', status: 'done', file, madeWith: 'Omni · Gemini', chat: { channelType: 'telegram', channelId: 'telegram:1' }, createdAt: 1, delivered: true });
    expect(a.sent).toEqual(['🎬 Your video is ready (Omni · Gemini).']);
    expect(a.files).toEqual([file]);
  });

  it('the apps: kept with the conversation as an artifact, and announced on its own', async () => {
    const file = join(home, 'song.mp3');
    writeFileSync(file, MP3);
    const a = fakeAgent('web');
    await Agent.prototype.deliverMediaJob.call(a.self as never, { id: 'k', kind: 'music', prompt: 'song', status: 'done', file, madeWith: 'Lyria 3.5 · Gemini', chat: { channelType: 'web', channelId: 'thread-1', sessionId: 'thread-1' }, createdAt: 1, delivered: true });
    expect(a.appended[0].content).toBe('🎵 Your music is ready (Lyria 3.5 · Gemini).');
    const refs = a.appended[0].metadata?.artifacts as Array<{ kind: string; name: string }>;
    expect(refs[0]).toMatchObject({ kind: 'audio', name: 'song.mp3' });
    expect(a.ready[0].artifacts).toEqual(refs);
    expect(existsSync(join(fixedHome, 'artifacts', 'index.json'))).toBe(true);
  });

  it('a failure is said plainly', async () => {
    const a = fakeAgent('telegram');
    await Agent.prototype.deliverMediaJob.call(a.self as never, { id: 'f', kind: 'video', prompt: 'x', status: 'failed', error: 'quota exceeded', chat: { channelType: 'telegram', channelId: 'telegram:1' }, createdAt: 1, delivered: true });
    expect(a.sent).toEqual(["⚠ I couldn't make the video: quota exceeded"]);
    expect(a.files).toEqual([]);
  });
});
