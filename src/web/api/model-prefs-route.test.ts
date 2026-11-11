import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// mercury.yaml's path is fixed when config.ts loads, so point MERCURY_HOME at
// a temp dir with one active provider before importing the routes.
const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-prefs-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:',
    '  owner: Test',
    'providers:',
    '  default: ollamaLocal',
    '  ollamaLocal:',
    '    name: ollamaLocal',
    '    baseUrl: http://127.0.0.1:9/v1',
    '    model: qwen3.8:27b',
    '    enabled: true',
    '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

import chat from './chat.js';
import { resetModelPrefsCache } from '../../utils/model-prefs.js';

function post(body: unknown) {
  return chat.request('http://127.0.0.1/api/chat/models/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function prefsOnDisk(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(home, 'model-prefs.json'), 'utf-8'));
  } catch {
    return {};
  }
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('POST /api/chat/models/prefs validation', () => {
  beforeEach(() => {
    rmSync(join(home, 'model-prefs.json'), { force: true });
    resetModelPrefsCache();
  });

  it('saves a label and reasoning for an active provider', async () => {
    const res = await post({ provider: 'ollamaLocal', model: 'qwen3.8:27b', label: 'Qwen', reasoning: 'off' });
    expect(res.status).toBe(200);
    expect(prefsOnDisk()['ollamaLocal::qwen3.8:27b']).toEqual({ label: 'Qwen', reasoning: 'off' });
  });

  it.each([
    ['non-string provider', { provider: 42, model: 'm' }],
    ['non-string model', { provider: 'ollamaLocal', model: { x: 1 } }],
    ['empty model', { provider: 'ollamaLocal', model: '' }],
    ['oversized model', { provider: 'ollamaLocal', model: 'm'.repeat(257) }],
    ['control characters', { provider: 'ollamaLocal', model: 'qwen\u0000' }],
    ['non-string label', { provider: 'ollamaLocal', model: 'm', label: 5 }],
    ['non-string reasoning', { provider: 'ollamaLocal', model: 'm', reasoning: ['high'] }],
    ['unknown reasoning', { provider: 'ollamaLocal', model: 'm', reasoning: 'turbo' }],
    ['unconfigured provider', { provider: 'openai', model: 'gpt-4o', label: 'x' }],
    ['__proto__ provider', { provider: '__proto__', model: 'm', label: 'x' }],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(prefsOnDisk()).toEqual({});
    expect(({} as Record<string, unknown>).label).toBeUndefined();
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/chat/models', () => {
  it('does not retry a failed Ollama lookup on every picker open', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const first = await chat.request('http://127.0.0.1/api/chat/models');
      const second = await chat.request('http://127.0.0.1/api/chat/models');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const tagCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/tags'));
      expect(tagCalls).toHaveLength(1);
      // Falls back to the configured model while Ollama is unreachable.
      const body = await second.json() as { providers: { model: string }[] };
      expect(body.providers.map((p) => p.model)).toEqual(['qwen3.8:27b']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('POST /api/chat/effort (#188)', () => {
  const effort = (body: unknown) => chat.request('http://127.0.0.1/api/chat/effort', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it("sets one chat's effort, reports it with the model's, and clears it", async () => {
    const { setCurrentProviderCallback } = await import('./chat.js');
    const prefs = await import('../../utils/model-prefs.js');
    prefs.resetChatEffortCache();
    setCurrentProviderCallback(() => ({ name: 'ollamaLocal', model: 'qwen3.8:27b' }));

    const set = await effort({ sessionId: 'thread-1', level: 'high' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { effort: unknown }).effort).toMatchObject({ effective: 'high', source: 'chat', chat: 'high' });

    const models = await (await chat.request('http://127.0.0.1/api/chat/models?sessionId=thread-1')).json() as { current: { effort: unknown } };
    expect(models.current.effort).toMatchObject({ effective: 'high', source: 'chat' });
    const other = await (await chat.request('http://127.0.0.1/api/chat/models?sessionId=thread-2')).json() as { current: { effort: unknown } };
    expect(other.current.effort).toMatchObject({ source: 'auto', chat: null });

    expect((await effort({ sessionId: 'thread-1', level: 'max' })).status).toBe(400);
    expect((await effort({ level: 'high' })).status).toBe(400);

    const cleared = await (await effort({ sessionId: 'thread-1', level: null })).json() as { effort: unknown };
    expect(cleared.effort).toMatchObject({ source: 'auto', chat: null });
  });
});
