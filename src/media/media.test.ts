import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byService } from './service.js';
import { imageModels, isImageModelEntry, listImageModels, resetMediaCatalogCache, withoutSnapshots, type MediaSource } from './catalog.js';
import { generateWith } from './image.js';
import { autoOrder, MediaService, resetUnusable, slug } from './service.js';
import { loadMediaPrefs, resetMediaPrefsCache, setMediaDefault } from './prefs.js';
import { applyMediaIntent, parseImageCommand } from './intent.js';
import { mediaCommand } from '../core/commands/chat-command.js';
import { ArtifactCollector } from '../artifacts/collector.js';

/**
 * Image generation (ADR-042): image models are found on the owner's
 * providers, called through the OpenAI Images API or OpenRouter's chat,
 * the owner's default and fallbacks are honoured, and an explicit request
 * is routed to generate_image instead of becoming an SVG.
 */
let home: string;
const previousHome = process.env.MERCURY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-media-'));
  process.env.MERCURY_HOME = home;
  resetMediaCatalogCache();
  resetMediaPrefsCache();
});
afterEach(() => {
  resetMediaCatalogCache();
  resetMediaPrefsCache();
  if (previousHome === undefined) delete process.env.MERCURY_HOME;
  else process.env.MERCURY_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const src = (name: string, baseUrl: string): MediaSource => ({ name, baseUrl, endpoint: async () => ({ baseUrl: baseUrl.replace(/\/$/, ''), headers: { Authorization: 'Bearer k' } }) });

describe('finding image models', () => {
  it('reads output modalities, types and names; skips vision and video models', () => {
    expect(isImageModelEntry({ id: 'x/any', output_modalities: ['image'] })).toBe(true);
    expect(isImageModelEntry({ id: 'x/chat', output_modalities: ['text'] })).toBe(false);
    expect(isImageModelEntry({ id: 'flux-pro', type: 'openai/image-generations' })).toBe(true);
    expect(isImageModelEntry({ id: 'gpt-image-1' })).toBe(true);
    expect(isImageModelEntry({ id: 'dall-e-3' })).toBe(true);
    expect(isImageModelEntry({ id: 'black-forest-labs/flux-1.1-pro' })).toBe(true);
    expect(isImageModelEntry({ id: 'gpt-4o' })).toBe(false);
    expect(isImageModelEntry({ id: 'qwen2.5-vl-72b' })).toBe(false);
    expect(isImageModelEntry({ id: 'gpt-image-1-video' })).toBe(false);
  });

  it('OpenRouter: image-output models, generated through chat', async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return json({ data: [
        { id: 'google/gemini-2.5-flash-image', architecture: { output_modalities: ['image', 'text'] } },
        { id: 'openai/gpt-4o', architecture: { output_modalities: ['text'] } },
      ] });
    }) as unknown as typeof fetch;
    const models = await listImageModels(src('openaiCompat', 'https://openrouter.ai/api/v1'), fake);
    expect(seen[0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=image');
    expect(models?.map((m) => [m.ref, m.backend, m.canEdit])).toEqual([['openaiCompat::google/gemini-2.5-flash-image', 'openrouter-chat', true]]);
  });

  it('LiteLLM: mode image_generation', async () => {
    const fake = (async () => json({ data: [
      { model_name: 'dalle', model_info: { mode: 'image_generation' } },
      { model_name: 'claude', model_info: { mode: 'chat' } },
    ] })) as unknown as typeof fetch;
    const models = await listImageModels(src('litellm', 'http://proxy:4000/v1'), fake);
    expect(models?.map((m) => m.model)).toEqual(['dalle']);
  });

  it('any other server: its /models list; a failure keeps what was known', async () => {
    let up = true;
    const fake = (async () => (up ? json({ data: [{ id: 'gpt-image-1' }, { id: 'gpt-4.1' }] }) : json({}, 500))) as unknown as typeof fetch;
    const sources = [src('openai', 'https://api.openai.com/v1')];
    expect((await imageModels(sources, { fetchImpl: fake })).map((m) => m.ref)).toEqual(['openai::gpt-image-1']);
    up = false;
    expect((await imageModels(sources, { fetchImpl: fake, refresh: true })).map((m) => m.ref)).toEqual(['openai::gpt-image-1']);
  });
});

describe('calling an image model', () => {
  const model = (id: string, backend: 'openai-images' | 'openrouter-chat' = 'openai-images') => ({ ref: `p::${id}`, provider: 'p', model: id, kind: 'image' as const, backend, label: id, group: 'P', canEdit: true });
  const ep = { baseUrl: 'http://srv/v1', headers: { Authorization: 'Bearer k' } };

  it('OpenAI Images: size from the aspect, base64 decoded, no response_format for gpt-image', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const fake = (async (u: string, init?: RequestInit) => { url = u; body = JSON.parse(String(init?.body)); return json({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a fox, watercolor' }] }); }) as unknown as typeof fetch;
    const r = await generateWith(model('gpt-image-1'), ep, { prompt: 'fox', aspect: 'landscape', quality: 'high' }, fake);
    expect(url).toBe('http://srv/v1/images/generations');
    expect(body).toEqual({ model: 'gpt-image-1', prompt: 'fox', n: 1, size: '1536x1024', quality: 'high' });
    expect(r.images[0]).toEqual({ bytes: PNG, mime: 'image/png' });
    expect(r.revisedPrompt).toBe('a fox, watercolor');
  });

  it('a server that answers with a URL: the image is downloaded', async () => {
    const fake = (async (u: string) => (u.endsWith('/generations') ? json({ data: [{ url: 'http://cdn/x.png' }] }) : new Response(PNG, { headers: { 'content-type': 'image/png' } }))) as unknown as typeof fetch;
    const r = await generateWith(model('flux-schnell'), ep, { prompt: 'fox' }, fake);
    expect(r.images[0].bytes.equals(PNG)).toBe(true);
  });

  it('edits go to /images/edits as multipart with the reference image', async () => {
    const ref = join(home, 'in.png');
    writeFileSync(ref, PNG);
    let url = '';
    let form: FormData | undefined;
    const fake = (async (u: string, init?: RequestInit) => { url = u; form = init?.body as FormData; return json({ data: [{ b64_json: PNG.toString('base64') }] }); }) as unknown as typeof fetch;
    await generateWith(model('gpt-image-1'), ep, { prompt: 'make it blue', references: [ref] }, fake);
    expect(url).toBe('http://srv/v1/images/edits');
    expect(form?.get('prompt')).toBe('make it blue');
    expect(form?.getAll('image[]')).toHaveLength(1);
  });

  it('OpenRouter chat: modalities and aspect ratio sent, data-URL images read back', async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return json({ choices: [{ message: { content: 'Here it is', images: [{ image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }] });
    }) as unknown as typeof fetch;
    const r = await generateWith(model('google/gemini-2.5-flash-image', 'openrouter-chat'), ep, { prompt: 'fox', aspect: 'portrait' }, fake);
    expect(body.modalities).toEqual(['image', 'text']);
    expect(body.image_config).toEqual({ aspect_ratio: '9:16' });
    expect(r.images[0].bytes.equals(PNG)).toBe(true);
    expect(r.note).toBe('Here it is');
  });

  it('a server error is reported with its message', async () => {
    const fake = (async () => json({ error: { message: 'Your request was rejected by the safety system' } }, 400)) as unknown as typeof fetch;
    await expect(generateWith(model('gpt-image-1'), ep, { prompt: 'x' }, fake)).rejects.toThrow('400: Your request was rejected by the safety system');
  });
});

describe('which model makes the image', () => {
  function service(listing: Record<string, string[]>, current = 'openai', generate?: (url: string, model: string) => Response) {
    const sources = Object.keys(listing).map((name) => src(name, `http://${name}/v1`));
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return json({ data: listing[new URL(url).hostname].map((id) => ({ id })) });
      const model = JSON.parse(String(init?.body)).model as string;
      return generate?.(url, model) ?? json({ data: [{ b64_json: PNG.toString('base64') }] });
    }) as unknown as typeof fetch;
    return new MediaService({ sources: () => sources, currentProvider: () => current }, fake);
  }

  it('automatic: the chat provider first, better-known models first', async () => {
    const s = service({ litellm: ['dall-e-3', 'flux-dev'], openai: ['dall-e-3', 'gpt-image-1'] });
    expect((await s.imageChain()).map((m) => m.ref)).toEqual(['openai::gpt-image-1', 'openai::dall-e-3', 'litellm::flux-dev']);
    expect(autoOrder((await s.imageModels()), 'litellm')[0].ref).toBe('litellm::flux-dev');
  });

  it("the owner's default and fallbacks come first", async () => {
    const s = service({ litellm: ['flux-dev'], openai: ['gpt-image-1'] });
    setMediaDefault('image', 'litellm::flux-dev');
    expect((await s.imageChain())[0].ref).toBe('litellm::flux-dev');
    expect(loadMediaPrefs().image?.primary).toBe('litellm::flux-dev');
    setMediaDefault('image', null);
    expect((await s.imageChain())[0].ref).toBe('openai::gpt-image-1');
  });

  it('a failing model hands over to the next, and the file is saved', async () => {
    const s = service({ openai: ['gpt-image-1', 'dall-e-3'] }, 'openai', (_u, model) => (model === 'gpt-image-1' ? json({ error: { message: 'rate limited' } }, 429) : json({ data: [{ b64_json: PNG.toString('base64') }] })));
    const out = join(home, 'out');
    const r = await s.generateImage({ prompt: 'A red fox in the snow' }, out);
    expect(r.model.ref).toBe('openai::dall-e-3');
    expect(r.failed).toEqual([{ ref: 'openai::gpt-image-1', error: '429: rate limited' }]);
    expect(r.files).toEqual([join(out, 'red-fox-in-snow.png')]);
    expect(readFileSync(r.files[0]).equals(PNG)).toBe(true);
    // A second one doesn't overwrite the first.
    const again = await s.generateImage({ prompt: 'A red fox in the snow', model: 'openai::dall-e-3' }, out);
    expect(again.files[0]).toBe(join(out, 'red-fox-in-snow (2).png'));
  });

  it('no image model anywhere: a clear error, not an SVG', async () => {
    const s = service({ openai: ['gpt-4.1'] });
    await expect(s.generateImage({ prompt: 'fox' }, join(home, 'out'))).rejects.toThrow(/No image model is set up/);
  });

  it('/media lists models, sets the default by number, and back to automatic', async () => {
    const s = service({ openai: ['gpt-image-1', 'dall-e-3'] });
    const shown = await mediaCommand(s, '');
    expect(shown.text).toContain('1. GPT Image 1');
    expect(shown.text).toContain('automatic');
    expect((await mediaCommand(s, 'image 2')).text).toContain('Images now use');
    expect(loadMediaPrefs().image?.primary).toBe('openai::dall-e-3');
    await mediaCommand(s, 'image auto');
    expect(loadMediaPrefs().image?.primary).toBeUndefined();
    resetMediaCatalogCache();
    expect((await mediaCommand(service({ other: ['gpt-4.1'] }), '')).text).toContain('no image model found');
  });
});

describe('asking for an image outright', () => {
  it('parses /image with flags', () => {
    expect(parseImageCommand('/image --landscape --model openai::gpt-image-1 a fox')).toEqual({ kind: 'image', prompt: 'a fox', aspect: 'landscape', model: 'openai::gpt-image-1' });
    expect(parseImageCommand('/imagine a fox')).toEqual({ kind: 'image', prompt: 'a fox' });
    expect(parseImageCommand('/image')).toBeNull();
    expect(parseImageCommand('/images of cats')).toBeNull();
  });

  it('routes the turn to generate_image, keeping attached files', () => {
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: [{ type: 'text', text: '/image make this blue' }, { type: 'image', image: 'x' }] }];
    const msg = { channelType: 'telegram', metadata: { attachments: [{ kind: 'image', path: '/tmp/up/a.png' }] } } as never;
    expect((applyMediaIntent(msg, '/image make this blue', messages) as { prompt?: string } | null)?.prompt).toBe('make this blue');
    expect(messages[0].content).toEqual([{ type: 'text', text: 'make this blue' }, { type: 'image', image: 'x' }]);
    expect(String(messages[1].content)).toContain('Call generate_image now');
    expect(String(messages[1].content)).toContain('"/tmp/up/a.png"');
  });

  it("the desktop's Image switch", () => {
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'a lighthouse at dusk' }];
    const msg = { channelType: 'web', metadata: { media: { kind: 'image', aspect: 'portrait' } } } as never;
    applyMediaIntent(msg, 'a lighthouse at dusk', messages);
    expect(messages[0].content).toBe('a lighthouse at dusk');
    expect(String(messages[1].content)).toContain('aspect "portrait"');
  });

  it('an ordinary message is left alone', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    expect(applyMediaIntent({ channelType: 'web', metadata: {} } as never, 'hello', messages)).toBeNull();
    expect(messages).toHaveLength(1);
  });
});

it('generated images are kept as deliverables', () => {
  const file = join(home, 'fox.png');
  writeFileSync(file, PNG);
  const c = new ArtifactCollector({ startedAt: Date.now() - 1000, cwd: home, surface: 'chat', mercuryHome: home });
  c.observe('generate_image', { prompt: 'fox' }, `Generated 1 image with GPT Image 1 (OpenAI API) in 2.0s:\n- ${file}\nIt is shown in the app.`);
  expect(c.size).toBe(1);
  expect(existsSync(file)).toBe(true);
});

it('file names come from the prompt', () => {
  expect(slug('Generate an image of a red fox, watercolor!')).toBe('red-fox-watercolor');
  expect(slug('!!!')).toBe('image');
});

it('dated snapshots are hidden when the plain name is offered', () => {
  const m = (id: string) => ({ ref: `o::${id}`, provider: 'o', model: id, kind: 'image' as const, backend: 'openai-images' as const, label: id, group: 'O', canEdit: true });
  expect(withoutSnapshots([m('gpt-image-2'), m('gpt-image-2-2026-04-21'), m('gpt-image-9-2026-01-01'), m('tts-1'), m('tts-1-1106')]).map((x) => x.model))
    .toEqual(['gpt-image-2', 'gpt-image-9-2026-01-01', 'tts-1']);
});

it('a model the account has no quota for is skipped by automatic picks for a day', async () => {
  resetUnusable();
  const sources = [src('openai', 'http://quota/v1')];
  const fake = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return json({ data: [{ id: 'gpt-image-1' }, { id: 'dall-e-3' }] });
    const m = JSON.parse(String(init?.body)).model;
    return m === 'gpt-image-1' ? json({ error: { message: 'Rate limit exceeded (limit: 0 requests per day on Free Tier)' } }, 429) : json({ data: [{ b64_json: PNG.toString('base64') }] });
  }) as unknown as typeof fetch;
  const s = new MediaService({ sources: () => sources, currentProvider: () => 'openai' }, fake);
  expect((await s.imageChain())[0].ref).toBe('openai::gpt-image-1');
  await s.generateImage({ prompt: 'x' }, join(home, 'q'));
  expect((await s.imageChain()).map((m) => m.ref)).toEqual(['openai::dall-e-3']);
  expect((await s.imageSetup()).auto?.ref).toBe('openai::dall-e-3');
  // Asked for by name: still tried.
  expect((await s.imageChain('openai::gpt-image-1'))[0].ref).toBe('openai::gpt-image-1');
  resetUnusable();
});


describe('media: a service by name', () => {
  const models = [
    { provider: 'gemini', group: 'Gemini', model: 'lyria-002', label: 'Lyria 2' },
    { provider: 'elevenlabs', group: 'ElevenLabs', model: 'music_v1', label: 'Music v1' },
  ];
  it('the named service only, however it is written', () => {
    expect(byService(models, 'ElevenLabs').map((m) => m.provider)).toEqual(['elevenlabs']);
    expect(byService(models, 'eleven labs').map((m) => m.provider)).toEqual(['elevenlabs']);
    expect(byService(models, 'lyria').map((m) => m.provider)).toEqual(['gemini']);
    expect(byService(models, 'suno')).toEqual([]);
  });
});
