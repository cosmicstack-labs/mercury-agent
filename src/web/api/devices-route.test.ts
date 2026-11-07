import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceFeed } from '../../plugins/device-feed.js';

/**
 * The app's microphone and permissions screen talks to desktop plugins
 * through these routes. They act on the computer Mercury runs on, so a
 * request from anywhere else is refused.
 */

const mgr = {
  devicePlugins: vi.fn(() => [{ id: 'optimus', name: 'Optimus' }]),
  deviceRequest: vi.fn(),
};
vi.mock('../../plugins/manager.js', () => ({ getPluginManager: () => mgr }));

const { default: devices } = await import('./devices.js');

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const REMOTE = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };

const post = (path: string, body: unknown, env = LOCAL) =>
  devices.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, env);

beforeEach(() => {
  mgr.deviceRequest.mockReset();
});

describe('/api/devices', () => {
  it('reports every running desktop plugin', async () => {
    mgr.deviceRequest.mockResolvedValue({ platform: 'macos', permissions: [], microphones: { devices: [] } });
    const res = await devices.request('/api/devices', {}, LOCAL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ id: string; report?: { platform: string } }> };
    expect(body.plugins).toEqual([{ id: 'optimus', name: 'Optimus', report: { platform: 'macos', permissions: [], microphones: { devices: [] } } }]);
    expect(mgr.deviceRequest).toHaveBeenCalledWith('optimus', 'status', {}, 20_000);
  });

  it('shows a plugin that can\'t report (an older version) with its reason instead of failing the page', async () => {
    mgr.deviceRequest.mockRejectedValue(new Error('This version of Optimus can\'t report devices yet. Update it: mercury plugins update optimus'));
    const body = (await (await devices.request('/api/devices', {}, LOCAL)).json()) as { plugins: Array<{ error?: string }> };
    expect(body.plugins[0].error).toMatch(/Update it/);
  });

  it('is refused from another computer, and says where to go instead', async () => {
    const res = await devices.request('/api/devices', {}, REMOTE);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ remote: true });
    expect((await post('/api/devices/optimus/select', { microphoneOn: false }, REMOTE)).status).toBe(403);
    expect(mgr.deviceRequest).not.toHaveBeenCalled();
  });

  it('asks for one known permission at a time', async () => {
    mgr.deviceRequest.mockResolvedValue({ ok: 1 });
    expect((await post('/api/devices/optimus/request', { kind: 'bluetooth' })).status).toBe(400);
    const res = await post('/api/devices/optimus/request', { kind: 'microphone', openSettings: true });
    expect(res.status).toBe(200);
    expect(mgr.deviceRequest).toHaveBeenCalledWith('optimus', 'request', { kind: 'microphone', openSettings: true }, 90_000);
  });

  it('passes on only the microphone choice and the on/off switch', async () => {
    mgr.deviceRequest.mockResolvedValue({});
    expect((await post('/api/devices/optimus/select', { volume: 3 })).status).toBe(400);
    await post('/api/devices/optimus/select', { microphone: 'USB Mic', microphoneOn: true, extra: 'x' });
    expect(mgr.deviceRequest).toHaveBeenCalledWith('optimus', 'select', { microphone: 'USB Mic', microphoneOn: true }, 20_000);
  });

  it('a stopped plugin is a conflict, not a server error', async () => {
    mgr.deviceRequest.mockRejectedValue(new Error('"optimus" is not running. Turn it on first.'));
    const res = await post('/api/devices/optimus/select', { microphoneOn: true });
    expect(res.status).toBe(409);
  });

  it('streams the test\'s levels for that plugin only, then the result', async () => {
    let finish: (v: unknown) => void = () => {};
    mgr.deviceRequest.mockImplementation(() => new Promise((r) => { finish = r; }));
    const res = await devices.request('/api/devices/optimus/test?seconds=99', {}, LOCAL);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Seconds are capped at 15.
    expect(mgr.deviceRequest).toHaveBeenCalledWith('optimus', 'test', { seconds: 15 }, 40_000);
    deviceFeed.level('optimus', { kind: 'microphone', level: 0.4 });
    deviceFeed.level('someone-else', { kind: 'microphone', level: 0.9 });
    deviceFeed.level('optimus', { kind: 'microphone', level: 7 });
    finish({ heard: true, text: 'USB Mic works: Optimus heard you.' });
    const text = await res.text();
    const levels = [...text.matchAll(/event: level\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).level);
    expect(levels).toEqual([0.4, 1]);
    expect(text).toContain('event: done');
    expect(text).toContain('Optimus heard you');
  });

  it('ends the test stream with the plugin\'s reason when it can\'t listen', async () => {
    mgr.deviceRequest.mockRejectedValue(new Error('macOS is blocking the microphone for Optimus.'));
    const text = await (await devices.request('/api/devices/optimus/test', {}, LOCAL)).text();
    expect(text).toContain('event: error');
    expect(text).toContain('blocking the microphone');
  });
});
