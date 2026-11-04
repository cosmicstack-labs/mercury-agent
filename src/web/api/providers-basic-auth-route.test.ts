import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-providers-basic-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:',
    '  owner: Test',
    'providers:',
    '  default: ollamaLocal',
    '  ollamaLocal:',
    '    name: ollamaLocal',
    '    baseUrl: https://ollama.example.test/v1',
    '    model: m',
    '    username: alice',
    '    password: s3cret',
    '    enabled: true',
    '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../utils/provider-models.js', () => ({ fetchProviderModelCatalog: catalog.fn }));

import providers from './providers.js';

const REMOTE = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };

function post(path: string, body: unknown, env?: unknown) {
  return providers.request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env as never);
}

afterEach(() => catalog.fn.mockReset());
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('saved username and password stay with their server', () => {
  it('never returns the password to the dashboard', async () => {
    for (const path of ['/api/providers', '/api/providers/settings']) {
      const res = await providers.request(`http://127.0.0.1${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('s3cret');
    }
  });

  it('sends them when a check targets the saved server', async () => {
    catalog.fn.mockResolvedValue({ recommendedModel: 'm', models: ['m'] });
    await post('/api/providers/ollamaLocal/check', {});
    expect(catalog.fn.mock.calls[0][1]).toMatchObject({ username: 'alice', password: 's3cret' });
  });

  it('drops them when a check targets a different server', async () => {
    catalog.fn.mockResolvedValue({ recommendedModel: 'm', models: ['m'] });
    await post('/api/providers/ollamaLocal/check', { baseUrl: 'https://evil.example.test/v1' });
    const sent = catalog.fn.mock.calls[0][1];
    expect(sent.baseUrl).toBe('https://evil.example.test/v1');
    expect(sent.username).toBeUndefined();
    expect(sent.password).toBeUndefined();
  });

  it('asks the owner before a remote device points them at another server, even with a new key', async () => {
    const res = await post('/api/providers/ollamaLocal', { baseUrl: 'https://evil.example.test/v1', apiKey: 'sk-newkey0000000000000000' }, REMOTE);
    expect(res.status).toBe(428);
    expect(readFileSync(join(home, 'mercury.yaml'), 'utf-8')).toContain('https://ollama.example.test/v1');
  });
});
