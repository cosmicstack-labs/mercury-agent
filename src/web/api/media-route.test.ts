import { describe, expect, it } from 'vitest';

await (async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.MERCURY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-media-route-'));
})();

const { default: media } = await import('./media.js');
const { setMediaService } = await import('../../media/runtime.js');
const { MediaService } = await import('../../media/service.js');
const { loadMediaPrefs, resetMediaPrefsCache } = await import('../../media/prefs.js');

describe('/api/media', () => {
  it('lists image models with the automatic pick, and sets the default', async () => {
    const fake = (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    setMediaService(new MediaService({ sources: () => [{ name: 'openai', baseUrl: 'http://o/v1', endpoint: async () => ({ baseUrl: 'http://o/v1', headers: {} }) }], currentProvider: () => 'openai' }, fake));
    const listed = await (await media.request('http://127.0.0.1/api/media/models')).json() as { image: { models: Array<{ ref: string }>; auto: { ref: string } | null; default: unknown } };
    expect(listed.image.models.map((m) => m.ref)).toEqual(['openai::gpt-image-1']);
    expect(listed.image.auto?.ref).toBe('openai::gpt-image-1');
    expect(listed.image.default).toBeNull();

    const put = (body: unknown) => media.request('http://127.0.0.1/api/media/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ kind: 'image', ref: 'openai::gpt-image-1' })).status).toBe(200);
    resetMediaPrefsCache();
    expect(loadMediaPrefs().image?.primary).toBe('openai::gpt-image-1');
    expect((await put({ kind: 'image', ref: 'not a ref' })).status).toBe(400);
    expect((await put({ kind: 'speech', ref: null })).status).toBe(400);
    setMediaService(null);
  });

  it('changes speech prefs, refusing bad values', async () => {
    const put = (body: unknown) => media.request('http://127.0.0.1/api/media/speech', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await put({ choice: 'openai', replies: 'always' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { speech: unknown }).speech).toEqual({ choice: 'openai', replies: 'always' });
    expect((await put({ voice: 'nova' })).status).toBe(200);
    resetMediaPrefsCache();
    expect(loadMediaPrefs().speech).toEqual({ choice: 'openai', replies: 'always', voice: 'nova' });
    expect((await put({ replies: 'sometimes' })).status).toBe(400);
    expect((await put({ choice: 'nonsense' })).status).toBe(400);
  });
});
