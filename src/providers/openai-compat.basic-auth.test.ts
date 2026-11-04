import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { redactSecrets } from '../utils/redact.js';

// A real HTTP server that behaves like nginx basic auth in front of Ollama.
const USER = 'alice';
const PASS = 's3cret';
const seen: Array<string | undefined> = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    const want = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
    if (req.headers.authorization !== want) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ollama"' }).end('unauthorized');
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const config = (over: Partial<ProviderConfig>): ProviderConfig => ({
  name: 'openaiCompat', apiKey: '', baseUrl, model: 'm', enabled: true, ...over,
});

describe('OpenAICompatProvider with username and password', () => {
  it('answers when the server demands Basic auth and the password is right', async () => {
    seen.length = 0;
    const p = new OpenAICompatProvider(config({ username: USER, password: PASS }), { useChatApi: true });
    const out = await p.generateText('ping', 'sys');
    expect(out.text).toBe('pong');
    expect(seen[0]).toMatch(/^Basic /);
  });

  it('replaces the Bearer header when both an API key and a username are set', async () => {
    seen.length = 0;
    const p = new OpenAICompatProvider(config({ apiKey: 'sk-ignored', username: USER, password: PASS }), { useChatApi: true });
    await p.generateText('ping', 'sys');
    expect(seen[0]).toMatch(/^Basic /);
  });

  it('fails with an authentication error when the password is wrong', async () => {
    const p = new OpenAICompatProvider(config({ username: USER, password: 'wrong' }), { useChatApi: true });
    await expect(p.generateText('ping', 'sys')).rejects.toThrow(/Authentication failed/);
  });

  it('keeps sending Bearer when no username is set', async () => {
    seen.length = 0;
    const p = new OpenAICompatProvider(config({ apiKey: 'sk-abc' }), { useChatApi: true });
    await expect(p.generateText('ping', 'sys')).rejects.toThrow();
    expect(seen[0]).toBe('Bearer sk-abc');
  });

  it('warns once when the password would travel over plain http to another machine', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      new OpenAICompatProvider(config({ baseUrl: 'http://ollama.example.com/v1', username: USER, password: PASS }));
      expect(warn).toHaveBeenCalledTimes(1);
      new OpenAICompatProvider(config({ username: USER, password: PASS }));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('registers the password so logs and tool output never show it', () => {
    new OpenAICompatProvider(config({ username: USER, password: 'registered-pw-123' }));
    expect(redactSecrets('config says registered-pw-123 here')).toBe('config says **** here');
  });

  it('is available with only a username (no API key)', () => {
    expect(new OpenAICompatProvider(config({ username: USER, password: PASS })).isAvailable()).toBe(true);
    expect(new OpenAICompatProvider(config({})).isAvailable()).toBe(false);
  });
});
