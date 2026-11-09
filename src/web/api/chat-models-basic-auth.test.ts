import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-basic-auth-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:',
    '  owner: Test',
    'providers:',
    '  default: ollamaLocal',
    '  ollamaLocal:',
    '    name: ollamaLocal',
    '    baseUrl: https://ollama.example.test/v1',
    '    model: qwen3.8:27b',
    '    username: alice',
    '    password: s3cret',
    '    enabled: true',
    '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

import chat from './chat.js';

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('GET /api/chat/models behind Basic auth', () => {
  it('lists the remote Ollama models with the configured username and password', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'gemma4:12b' }] }), { status: 200 }),
    );
    try {
      const res = await chat.request('http://127.0.0.1/api/chat/models');
      expect(res.status).toBe(200);
      const tags = fetchSpy.mock.calls.find(([url]) => String(url) === 'https://ollama.example.test/api/tags');
      expect(tags).toBeDefined();
      expect((tags![1] as RequestInit).headers).toEqual({ Authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}` });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
