import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairingFailureError, pollPairingComplete, refreshToken } from './pairing.js';

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

describe('pollPairingComplete', () => {
  it('rejects a failed response even when it also contains credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        status: 'failed',
        error: 'Free tier allows one agent',
        code: 'AGENT_LIMIT_REACHED',
        jwt: 'must-not-be-used',
        refreshToken: 'must-not-be-used',
        agentId: 'hidden-agent',
      }),
    }));

    await expect(pollPairingComplete('https://api.example.com', 'code', 100, 0)).rejects.toMatchObject({
      name: 'PairingFailureError',
      details: expect.objectContaining({ code: 'AGENT_LIMIT_REACHED' }),
    });
  });

  it('preserves a structured capacity failure returned as HTTP 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        error: 'Agent limit reached',
        code: 'AGENT_LIMIT_REACHED',
        tier: 'free',
        used: 1,
        limit: 1,
      }),
    }));

    try {
      await pollPairingComplete('https://api.example.com', 'code', 100, 0);
      throw new Error('Expected pairing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PairingFailureError);
      expect((error as PairingFailureError).details).toMatchObject({
        code: 'AGENT_LIMIT_REACHED',
        used: 1,
        limit: 1,
      });
    }
  });
});
