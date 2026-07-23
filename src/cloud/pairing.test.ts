import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshToken } from './pairing.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshToken', () => {
  it('shares a single-use token rotation across concurrent consumers', async () => {
    const result = { jwt: 'new-jwt', refreshToken: 'new-refresh' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => result,
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = `old-refresh-${Date.now()}`;
    const [first, second] = await Promise.all([
      refreshToken('https://api.example.com', token),
      refreshToken('https://api.example.com', token),
    ]);

    expect(first).toEqual(result);
    expect(second).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed refresh attempts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jwt: 'jwt', refreshToken: 'next' }) });
    vi.stubGlobal('fetch', fetchMock);

    const token = `retry-refresh-${Date.now()}`;
    await expect(refreshToken('https://api.example.com', token)).rejects.toThrow('503');
    await expect(refreshToken('https://api.example.com', token)).resolves.toEqual({ jwt: 'jwt', refreshToken: 'next' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
