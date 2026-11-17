import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-voice-providers-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
  return dir;
});

import voiceProviders from './voice-providers.js';
import mobileVoice from './mobile-voice.js';
import { setVoiceProviderFetch } from '../../plugins/voice-providers.js';
import { VOICE_KEY_ENV } from '../../plugins/voice-check.js';
import { pluginKeysPath, readPluginKeys, secretValue, setPluginKey } from '../../plugins/store.js';
import { OwnerApprovals, _setOwnerApprovals, ownerApprovals } from '../../security/owner-approvals.js';
import { readAudit } from '../../security/audit.js';
import { API_FEATURES } from '../api-contract.js';

const GEMINI_KEY = 'AIzaSyTest-gemini-key-000000001234';
const ELEVEN_KEY = 'sk_eleven_test_key_0000000000abcd';
const OPENAI_KEY = 'sk-test-openai-000000000000wxyz';
const LAN = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };

const list = () => voiceProviders.request('http://127.0.0.1/api/voice/providers');
const put = (id: string, apiKey: string | null, env?: object, headers: Record<string, string> = {}) =>
  voiceProviders.request(`http://127.0.0.1/api/voice/providers/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ apiKey }) }, env);
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const ok = vi.fn().mockResolvedValue(reply(200, { models: [{ name: 'models/gemini-3.8-live' }], voices: [] }));

beforeEach(() => {
  _setOwnerApprovals(new OwnerApprovals());
  setVoiceProviderFetch(ok as never);
});
afterEach(() => {
  setVoiceProviderFetch(undefined);
  for (const k of Object.values(VOICE_KEY_ENV)) delete process.env[k];
  rmSync(pluginKeysPath(), { force: true });
  rmSync(join(home, 'plugins'), { recursive: true, force: true });
  writeFileSync(join(home, 'mercury.yaml'), 'identity:\n  owner: Test\n');
});

describe('voice providers share one key store with Optimus', () => {
  it('covers every voice secret the Optimus plugin declares', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'plugins/optimus/mercury-plugin.template.json'), 'utf8')) as { permissions: { secrets: string[] } };
    expect(new Set(Object.values(VOICE_KEY_ENV))).toEqual(new Set(manifest.permissions.secrets));
  });

  it('lists providers without ever revealing a key', async () => {
    setPluginKey('GEMINI_API_KEY', GEMINI_KEY);
    process.env.ELEVENLABS_API_KEY = ELEVEN_KEY;
    writeFileSync(join(home, 'mercury.yaml'), ['identity:', '  owner: Test', 'providers:', '  openai:', '    name: openai', `    apiKey: ${OPENAI_KEY}`, '    baseUrl: https://api.openai.com/v1', '    model: gpt-4o-mini', '    enabled: true', ''].join('\n'));
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    for (const k of [GEMINI_KEY, ELEVEN_KEY, OPENAI_KEY]) expect(text).not.toContain(k.slice(0, -4));
    const body = JSON.parse(text) as { providers: Array<Record<string, unknown>>; capabilities: Record<string, unknown> };
    const by = Object.fromEntries(body.providers.map((p) => [p.id, p]));
    expect(by.gemini).toMatchObject({ env: 'GEMINI_API_KEY', set: true, source: 'store', hint: '1234', canEdit: true, uses: ['calls', 'optimus'] });
    expect(by.elevenlabs).toMatchObject({ set: true, source: 'env', hint: 'abcd', canEdit: false });
    expect(by.openai).toMatchObject({ env: null, set: true, source: 'provider', hint: 'wxyz', canEdit: false });
    expect(by.deepgram).toMatchObject({ set: false, source: null, canEdit: true });
    expect(by.deepgram.hint).toBeUndefined();
    expect(body.capabilities).toMatchObject({ call: true, callEngine: 'openai', dictation: true });
  });

  it('saves into the shared store (what Optimus reads) and removes with null', async () => {
    const res = await put('gemini', `  ${GEMINI_KEY}  `);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GEMINI_KEY);
    expect(JSON.parse(text)).toMatchObject({ ok: true, verified: true, provider: { id: 'gemini', set: true, source: 'store', hint: '1234' } });
    // The same store and name Optimus's settings write (manager.setSetting → setPluginKey(field.secret)).
    expect(readPluginKeys().GEMINI_API_KEY).toBe(GEMINI_KEY);
    expect(secretValue('GEMINI_API_KEY')).toBe(GEMINI_KEY);
    // The check went to Gemini, with this key.
    expect(String(ok.mock.calls.at(-1)?.[0])).toContain('generativelanguage.googleapis.com');
    expect(readAudit(5)[0]).toMatchObject({ kind: 'voice.key.set', detail: expect.stringContaining('GEMINI_API_KEY') });
    expect(JSON.stringify(readAudit(5))).not.toContain(GEMINI_KEY);

    const del = await put('gemini', null);
    expect(del.status).toBe(200);
    expect(secretValue('GEMINI_API_KEY')).toBeUndefined();
    expect(readAudit(5)[0]).toMatchObject({ kind: 'voice.key.removed' });
  });

  it('a key Optimus saved shows up here', async () => {
    setPluginKey('DEEPGRAM_API_KEY', '0123456789abcdef0123456789abcdef01234567');
    const body = (await (await list()).json()) as { providers: Array<{ id: string; set: boolean; source: string }> };
    expect(body.providers.find((p) => p.id === 'deepgram')).toMatchObject({ set: true, source: 'store' });
  });

  it('does not save a key the provider rejects, and never echoes it', async () => {
    setVoiceProviderFetch(vi.fn().mockResolvedValue(reply(401, { detail: { message: `bad key ${ELEVEN_KEY}` } })) as never);
    const res = await put('elevenlabs', ELEVEN_KEY);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(ELEVEN_KEY);
    expect(JSON.parse(text)).toMatchObject({ ok: false, verified: true, error: expect.stringContaining('rejected') });
    expect(secretValue('ELEVENLABS_API_KEY')).toBeUndefined();
  });

  it('saves unverified when the provider cannot be reached', async () => {
    setVoiceProviderFetch(vi.fn().mockRejectedValue(new Error('fetch failed')) as never);
    const res = await put('deepgram', '0123456789abcdef0123456789abcdef01234567');
    expect(await res.json()).toMatchObject({ ok: true, verified: false });
    expect(secretValue('DEEPGRAM_API_KEY')).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('rejects keys that are obviously not keys', async () => {
    expect((await put('gemini', 'short')).status).toBe(400);
    expect((await put('gemini', 'has a space in it')).status).toBe(400);
    expect((await put('nope', GEMINI_KEY)).status).toBe(404);
    expect((await put('openai', OPENAI_KEY)).status).toBe(400);
    expect(ok).not.toHaveBeenCalledWith(expect.stringContaining('short'), expect.anything());
  });

  it('refuses a key set in the environment, without asking the owner', async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    const res = await put('gemini', 'AIzaSyAnother-key-0000000000000', LAN);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, envSet: true, error: expect.stringContaining('.env') });
    expect(readPluginKeys().GEMINI_API_KEY).toBeUndefined();
    expect(ownerApprovals().pending()).toHaveLength(0);
  });

  it('from another device, the owner approves first', async () => {
    const first = await put('gemini', GEMINI_KEY, LAN);
    expect(first.status).toBe(428);
    const ask = (await first.json()) as { approvalId: string; code: string; error: string };
    expect(ask.error).toContain('Gemini');
    expect(JSON.stringify(ask)).not.toContain(GEMINI_KEY);
    expect(secretValue('GEMINI_API_KEY')).toBeUndefined();
    ownerApprovals().decide(ask.code, 'allow', 'telegram');
    const second = await put('gemini', GEMINI_KEY, LAN, { 'X-Mercury-Approval': ask.approvalId });
    expect(second.status).toBe(200);
    expect(secretValue('GEMINI_API_KEY')).toBe(GEMINI_KEY);
  });

  it('capabilities reflect a newly saved key at once', async () => {
    const before = (await (await mobileVoice.request('http://127.0.0.1/api/mobile/voice/capabilities')).json()) as Record<string, unknown>;
    expect(before).toMatchObject({ call: false, dictation: false });
    const saved = (await (await put('gemini', GEMINI_KEY)).json()) as { capabilities: Record<string, unknown> };
    expect(saved.capabilities).toMatchObject({ call: true, callEngine: 'gemini', callEngineName: 'Gemini Live', dictation: false });
    await put('elevenlabs', ELEVEN_KEY);
    const after = (await (await mobileVoice.request('http://127.0.0.1/api/mobile/voice/capabilities')).json()) as Record<string, unknown>;
    expect(after).toMatchObject({ call: true, callEngine: 'gemini', dictation: true, dictationEngine: 'elevenlabs', dictationEngineName: 'ElevenLabs Scribe' });
  });

  it('is advertised to clients', () => {
    expect(API_FEATURES).toContain('voice.providers');
  });
});
