import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempHome } from '../../plugins/test-fixtures.js';
import { createDevice, getDevice, _resetDeviceState } from '../devices.js';
import { _resetPresence, isLive, openLiveLink } from '../../reach/presence.js';
import { _setReachService, ReachService } from '../../reach/service.js';
import { addMissed, listMissed } from '../../reach/missed.js';
import { readAudit } from '../../security/audit.js';
import { setMobileVoiceFetch } from './mobile-voice.js';

/**
 * The phone's side of calls from Mercury (ADR-046): each phone registers
 * and reports only for itself; nothing here is reachable by a browser or
 * another device on the phone's behalf.
 */

const { default: reach } = await import('./reach.js');
const { default: mobileVoice } = await import('./mobile-voice.js');

const ENV = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };
const call = (app: { request: typeof reach.request }, path: string, token: string | null, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, ENV);

describe('phone reach routes', () => {
  let env: ReturnType<typeof tempHome>;
  let phoneA: { id: string; token: string };
  let phoneB: { id: string; token: string };
  let service: ReachService;

  beforeEach(() => {
    env = tempHome();
    _resetDeviceState();
    _resetPresence();
    const a = createDevice('iPhone', 'ios');
    const b = createDevice('Pixel', 'android');
    phoneA = { id: a.device.id, token: a.token };
    phoneB = { id: b.device.id, token: b.token };
    service = new ReachService({ ringTimeoutMs: 2000 });
    _setReachService(service);
  });
  afterEach(() => { _setReachService(null); _resetPresence(); setMobileVoiceFetch(undefined); delete process.env.GEMINI_API_KEY; env.restore(); });

  it('a phone registers how to reach it, and the change is audited', async () => {
    const res = await call(reach, '/api/devices/me/reach', phoneA.token, 'PUT', { platform: 'ios', appVersion: '1.5.0 (60)', ring: true, notify: false, capabilities: ['callkit', 'BAD CAP!'] });
    expect(res.status).toBe(200);
    expect(getDevice(phoneA.id)?.reach).toMatchObject({ platform: 'ios', appVersion: '1.5.0 (60)', ring: true, notify: false, capabilities: ['callkit', 'badcap'] });
    expect(readAudit(5).find((e) => e.kind === 'device.reach')?.who).toBe(`iPhone (${phoneA.id})`);
    const got = (await (await call(reach, '/api/devices/me/reach', phoneA.token)).json()) as { reach: { notify: boolean }; live: boolean; settings: { calls: boolean } };
    expect(got).toMatchObject({ reach: { notify: false }, live: false, settings: { calls: true } });
    expect((await call(reach, '/api/devices/me/reach', phoneA.token, 'PUT', { platform: 'windows' })).status).toBe(400);
  });

  it('only a paired device, for itself: no token or a browser is refused', async () => {
    expect((await call(reach, '/api/devices/me/reach', null, 'PUT', { platform: 'ios' })).status).toBe(403);
    expect((await call(reach, '/api/devices/me/missed', null)).status).toBe(403);
    expect((await call(reach, '/api/devices/me/ring/r1', null, 'POST', { outcome: 'answered' })).status).toBe(403);
  });

  it('a ring is answered by the phone it went to, not by another', async () => {
    const events: Array<[string, unknown]> = [];
    openLiveLink(phoneA.id, (e, d) => events.push([e, d]));
    const p = service.callOwner({ reason: 'the build broke', followUp: false });
    await Promise.resolve();
    const id = (events[0][1] as { id: string }).id;
    expect((await call(reach, `/api/devices/me/ring/${id}`, phoneB.token, 'POST', { outcome: 'answered' })).status).toBe(404);
    expect((await call(reach, `/api/devices/me/ring/${id}`, phoneA.token, 'POST', { outcome: 'maybe' })).status).toBe(400);
    const ok = await call(reach, `/api/devices/me/ring/${id}`, phoneA.token, 'POST', { outcome: 'answered' });
    expect(await ok.json()).toEqual({ ok: true, state: 'answered' });
    expect((await p).outcome).toBe('answered');
  });

  it('the answered call\'s reason opens the live voice session (only for that phone)', async () => {
    process.env.GEMINI_API_KEY = 'AIza-test-gemini-key';
    setMobileVoiceFetch(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: 'auth_tokens/test' }) })) as never);
    const events: Array<[string, unknown]> = [];
    openLiveLink(phoneA.id, (e, d) => events.push([e, d]));
    openLiveLink(phoneB.id, () => {});
    // Ringing phone A only: phone B can't borrow the invite.
    const p = service.callOwner({ reason: 'the build broke', followUp: false, deviceIds: [phoneA.id] });
    await Promise.resolve();
    const id = (events[0][1] as { id: string }).id;
    const session = async (token: string, body: unknown) => (await call(mobileVoice, '/api/mobile/voice/session', token, 'POST', body)).json() as Promise<{ instructions?: string; opener?: string }>;
    expect((await session(phoneB.token, { callInviteId: id })).opener).toBeUndefined();
    const a = await session(phoneA.token, { callInviteId: id });
    expect(a.opener).toBe('You called the owner and they answered. Why you called: the build broke. Greet them, explain why you called in one or two sentences, and help with whatever they need.');
    expect(a.instructions?.endsWith(`\n\n${a.opener}`)).toBe(true);
    // Starting the session counted as answering.
    expect((await p).outcome).toBe('answered');
    // A plain session is unchanged.
    const plain = await session(phoneA.token, {});
    expect(plain.opener).toBeUndefined();
    expect(plain.instructions).not.toMatch(/You called the owner/);
    expect(plain.instructions).toBe(a.instructions?.slice(0, -(a.opener!.length + 2)));
  });

  it('missed items: listed, then acknowledged once for every phone', async () => {
    const m1 = addMissed({ kind: 'call', title: 'Missed call from Mercury', body: 'x', urgency: 'normal' });
    addMissed({ kind: 'notification', title: 'FYI', body: 'y', urgency: 'normal' });
    const items = ((await (await call(reach, '/api/devices/me/missed', phoneB.token)).json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
    expect(await (await call(reach, '/api/devices/me/missed/ack', phoneA.token, 'POST', { ids: [m1.id] })).json()).toEqual({ removed: 1 });
    expect(listMissed().map((m) => m.title)).toEqual(['FYI']);
    expect(await (await call(reach, '/api/devices/me/missed/ack', phoneA.token, 'POST', { all: true })).json()).toEqual({ removed: 1 });
  });

  it('test ring: only when this phone is live, and only this phone', async () => {
    expect((await call(reach, '/api/devices/me/test-ring', phoneA.token, 'POST')).status).toBe(409);
    const a: string[] = [];
    const b: string[] = [];
    openLiveLink(phoneA.id, (e) => a.push(e));
    openLiveLink(phoneB.id, (e) => b.push(e));
    expect(isLive(phoneA.id)).toBe(true);
    expect((await call(reach, '/api/devices/me/test-ring', phoneA.token, 'POST')).status).toBe(200);
    await Promise.resolve();
    expect(a).toEqual(['ring']);
    expect(b).toEqual([]);
  });

  it('settings: read and changed by the owner\'s apps, audited, validated', async () => {
    const res = await call(reach, '/api/reach/settings', phoneA.token, 'PUT', { calls: false, quietHours: { enabled: true, start: '23:00', end: '06:00' }, maxCallsPerHour: 'lots' });
    const { settings } = (await res.json()) as { settings: { calls: boolean; quietHours: unknown; maxCallsPerHour: number } };
    expect(settings).toMatchObject({ calls: false, quietHours: { enabled: true, start: '23:00', end: '06:00' }, maxCallsPerHour: 4 });
    expect(readAudit(5).find((e) => e.kind === 'reach.settings')?.detail).toBe('calls, quietHours');
  });

  it('lists the phones with live presence and no secrets', async () => {
    openLiveLink(phoneB.id, () => {});
    const { phones } = (await (await call(reach, '/api/reach/phones', phoneA.token)).json()) as { phones: Array<Record<string, unknown>> };
    expect(phones.map((p) => [p.name, p.platform, p.live])).toEqual([['iPhone', 'ios', false], ['Pixel', 'android', true]]);
    expect(JSON.stringify(phones)).not.toMatch(/tokenHash|mdt_/);
  });
});
