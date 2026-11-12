import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-live-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:', '  owner: Test', 'providers:', '  default: mercuryCloud', '  mercuryCloud:', '    name: mercuryCloud', '    apiKey: sk-mc-test', '    baseUrl: https://cloud.test', '    model: mercury-pro', '    enabled: true', '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
});

const { default: chat, setTurnControls, setWebChannel, setCurrentProviderCallback } = await import('./chat.js');
const { WebChannel } = await import('../../channels/web.js');
const { TurnTrace } = await import('../../core/turn-trace.js');
const { setMediaService } = await import('../../media/runtime.js');
const { MediaService } = await import('../../media/service.js');

/**
 * Coming back to a chat mid-reply shows it as far as it got; the model
 * picker lists Mercury Cloud's models for the account's tier and says when
 * the Cloud sign-in has expired.
 */
describe('a reply still being worked on', () => {
  it('its thinking and steps so far, what it is doing, and the text written so far', async () => {
    const web = new WebChannel('Mercury');
    (web as unknown as { broadcast: () => boolean }).broadcast = () => true;
    setWebChannel(web);
    let now = 1000;
    const trace = new TurnTrace(() => now);
    trace.reasoning('Planning.');
    trace.toolStarted('c1', 'Running npm test');
    setTurnControls({
      running: () => [], waiting: () => [], limit: () => ({ limit: 4, configured: 0, auto: 4 }), setLimit: () => {},
      live: (id) => (id === 'thread-1' ? { startedAt: 900, activity: '⚙️ Running npm test', trace: trace.peek(900) } : undefined),
    });
    async function* chunks() { yield 'Half '; yield 'an answer'; }
    await web.stream(chunks(), 'thread-1');

    const body = await (await chat.request('http://127.0.0.1/api/chat/threads/thread-1/live')).json() as Record<string, any>;
    expect(body.running).toBe(true);
    expect(body.text).toBe('Half an answer');
    expect(body.trace.items.map((i: { kind: string }) => i.kind)).toEqual(['reasoning', 'tool']);
    // Nothing is ended by looking: the tool still runs, the thinking block is closed only by the tool start.
    expect(body.trace.items[1]).toMatchObject({ id: 'c1', status: 'running' });

    expect(await (await chat.request('http://127.0.0.1/api/chat/threads/thread-2/live')).json()).toEqual({ running: false });
    // The reply arrived: no longer live text.
    await web.send('Half an answer.', 'thread-1');
    expect(web.liveTextFor('thread-1')).toBe('');
    now++;
  });

  it('a later round of the same turn writes on after the earlier text; a cleared turn starts fresh', async () => {
    const web = new WebChannel('Mercury');
    (web as unknown as { broadcast: () => boolean }).broadcast = () => true;
    async function* a() { yield 'First.'; }
    async function* b() { yield ' Second.'; }
    await web.stream(a(), 't');
    await web.stream(b(), 't');
    expect(web.liveTextFor('t')).toBe('First. Second.');
    web.clearLiveText('t');
    expect(web.liveTextFor('t')).toBe('');
  });
});

describe('Mercury Cloud in the model picker', () => {
  function withCloud(respond: () => Response) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
    setMediaService(new MediaService({
      sources: () => [{ name: 'mercuryCloud', baseUrl: 'https://cloud.test', endpoint: async () => ({ baseUrl: 'https://cloud.test/v1', headers: { Authorization: 'Bearer t' } }) }],
      currentProvider: () => 'mercuryCloud',
    }));
    setCurrentProviderCallback(() => ({ name: 'mercuryCloud', model: 'mercury-pro' }));
    return fetchSpy;
  }

  it("lists the models this account's tier may use, with Cloud's names", async () => {
    const spy = withCloud(() => new Response(JSON.stringify({ data: [
      { id: 'mercury-pro', label: 'Mercury Pro', available: true },
      { id: 'mercury-flash', label: 'Mercury Flash', available: true },
      { id: 'mercury-opus', label: 'Mercury Opus', available: false },
      { id: 'mercury-tts', label: 'Voice', available: true },
    ] }), { headers: { 'content-type': 'application/json' } }));
    const body = await (await chat.request('http://127.0.0.1/api/chat/models')).json() as { providers: Array<{ name: string; model: string; label: string }>; notices: string[] };
    const cloud = body.providers.filter((p) => p.name === 'mercuryCloud');
    expect(cloud.map((p) => p.model)).toEqual(['mercury-pro', 'mercury-flash']);
    expect(cloud.map((p) => p.label)).toEqual(['Mercury Pro', 'Mercury Flash']);
    expect(body.notices).toEqual([]);
    spy.mockRestore();
  });
});
