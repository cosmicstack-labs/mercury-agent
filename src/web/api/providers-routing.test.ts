import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same shape as model-prefs-route.test.ts: the config path is fixed when
// config.ts loads, so the home is prepared before the route is imported.
const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-providers-route-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

import providers from './providers.js';

function writeConfig(extra: string[] = []): void {
  writeFileSync(
    join(home, 'mercury.yaml'),
    [
      'identity:',
      '  owner: Test',
      'providers:',
      '  default: openrouter',
      '  openrouter:',
      '    name: openrouter',
      '    apiKey: sk-or-test',
      '    baseUrl: https://openrouter.ai/api/v1',
      '    model: deepseek/deepseek-v4.1-flash-1017',
      '    enabled: true',
      '  litellm:',
      '    name: litellm',
      '    baseUrl: http://localhost:4000/v1',
      '    model: local-model',
      '    enabled: false',
      ...extra,
      '',
    ].join('\n'),
  );
}

function post(name: string, body: unknown) {
  return providers.request(`http://127.0.0.1/api/providers/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function list() {
  const res = await providers.request('http://127.0.0.1/api/providers');
  return (await res.json()) as Array<{
    name: string;
    baseUrl?: string;
    model?: string;
    enabled?: boolean;
    routing?: Record<string, unknown>;
  }>;
}

beforeEach(() => {
  writeConfig();
});

describe('provider endpoint routing', () => {
  it('stores a pin and asks for a restart', async () => {
    const res = await post('openrouter', {
      routing: { order: ['inference-net'], quantizations: ['fp8'] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, restartRequired: true });

    const entry = (await list()).find((p) => p.name === 'openrouter');
    expect(entry?.routing).toEqual({ order: ['inference-net'], quantizations: ['fp8'] });
  });

  it('clears the pin when the lists are emptied', async () => {
    await post('openrouter', { routing: { order: ['inference-net'] } });
    const res = await post('openrouter', { routing: { order: [] } });

    expect(res.status).toBe(200);
    const entry = (await list()).find((p) => p.name === 'openrouter');
    expect(entry?.routing).toBeUndefined();
  });

  it('trims names and keeps an explicit allowFallbacks', async () => {
    await post('openrouter', {
      routing: { order: ['  inference-net  '], quantizations: ['fp8 '], allowFallbacks: true },
    });

    const entry = (await list()).find((p) => p.name === 'openrouter');
    expect(entry?.routing).toEqual({
      order: ['inference-net'],
      quantizations: ['fp8'],
      allowFallbacks: true,
    });
  });

  it('refuses a malformed pin instead of writing half of it', async () => {
    const res = await post('openrouter', { routing: { order: 'inference-net' } });

    expect(res.status).toBe(400);
    const entry = (await list()).find((p) => p.name === 'openrouter');
    expect(entry?.routing).toBeUndefined();
  });

  it('drops keys it does not know', async () => {
    await post('openrouter', { routing: { order: ['inference-net'], quantize: 'fp8' } });

    const entry = (await list()).find((p) => p.name === 'openrouter');
    expect(entry?.routing).toEqual({ order: ['inference-net'] });
  });

  it('refuses a pin on a gateway that would not read it', async () => {
    const res = await post('litellm', { routing: { order: ['inference-net'] } });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Endpoint routing is OpenRouter-only' });
  });

  it('leaves the rest of the provider untouched', async () => {
    writeConfig();
    const before = (await list()).find((p) => p.name === 'openrouter');

    await post('openrouter', { routing: { order: ['inference-net'] } });

    const after = (await list()).find((p) => p.name === 'openrouter');
    expect(after).toMatchObject({ baseUrl: before?.baseUrl, model: before?.model, enabled: true });
  });

  it('writes the pin to disk, not just to memory', async () => {
    await post('openrouter', { routing: { order: ['inference-net'], quantizations: ['fp8'] } });

    const yaml = readFileSync(join(home, 'mercury.yaml'), 'utf-8');
    expect(yaml).toContain('inference-net');
    expect(yaml).toContain('fp8');
  });
});
