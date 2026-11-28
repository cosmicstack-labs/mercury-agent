import { afterEach, expect, it, vi } from 'vitest';
import { fetchChatGPTModels } from './chatgpt-models.js';
import type { ChatGPTSession } from './chatgpt-session.js';

function session(accountId: string): ChatGPTSession {
  return {
    accountId, accessToken: 'fixture', refreshToken: 'fixture',
    authenticatedAt: '2026-01-01T00:00:00Z', expiresAt: '',
  };
}

afterEach(() => vi.unstubAllGlobals());

it('uses the signed-in catalog order and skips hidden and duplicate IDs', async () => {
  const fetch = vi.fn(async () => Response.json({ models: [
    { slug: 'gpt-5.6-sol', priority: 9 },
    { slug: 'gpt-6-sol', priority: 6 },
    { slug: 'gpt-6.1-sol', priority: 5 },
    { slug: 'gpt-6.2-sol', priority: 1 },
    { slug: 'gpt-6.2-sol', priority: 1 },
    { slug: 'internal', visibility: 'hide', priority: 0 },
    { slug: 42 },
  ] }));
  vi.stubGlobal('fetch', fetch);

  expect(await fetchChatGPTModels(session('ranked'))).toEqual({
    recommendedModel: 'gpt-6.2-sol',
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'],
  });
  expect(fetch).toHaveBeenCalledWith(
    'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
    expect.objectContaining({ headers: expect.objectContaining({ 'ChatGPT-Account-Id': 'ranked' }) }),
  );
});

it('shares lookups, refreshes on expiry or request, and isolates sign-ins', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const fetch = vi.fn()
      .mockImplementationOnce(async () => Response.json({ models: [{ slug: 'first' }] }))
      .mockImplementationOnce(async () => Response.json({ models: [{ slug: 'second' }] }))
      .mockImplementationOnce(async () => Response.json({ models: [{ slug: 'third' }] }))
      .mockImplementationOnce(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const account = session('cache-test');
    const first = fetchChatGPTModels(account);
    expect(fetchChatGPTModels(account)).toBe(first);
    expect((await first).recommendedModel).toBe('first');
    expect(fetchChatGPTModels(account)).toBe(first);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await fetchChatGPTModels(account)).recommendedModel).toBe('second');
    expect((await fetchChatGPTModels(account, { forceRefresh: true })).recommendedModel).toBe('third');
    const relogin = { ...account, authenticatedAt: '2026-01-02T00:00:00Z' };
    await expect(fetchChatGPTModels(relogin)).rejects.toThrow('Check your ChatGPT sign-in');
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});
