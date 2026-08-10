import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
  refreshToken: vi.fn(),
  redeemAgentApiKey: vi.fn(),
}));

vi.mock('../utils/config.js', () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
  updateConfig: mocks.updateConfig,
}));
vi.mock('./pairing.js', () => ({
  refreshToken: mocks.refreshToken,
  redeemAgentApiKey: mocks.redeemAgentApiKey,
}));

import { CloudTokenStore } from './token-store.js';
import type { MercuryConfig } from '../utils/config.js';

function config(jwt = 'old-jwt', refreshToken = 'old-refresh'): MercuryConfig {
  return {
    cloud: { enabled: true, apiUrl: 'https://api.example.com', wsUrl: 'wss://api.example.com/ws', jwt, refreshToken, agentId: 'agent-1', tier: 'free', agentApiKey: 'mcapk_agent_1' },
    providers: { mercuryCloud: { name: 'mercuryCloud', enabled: true, apiKey: jwt, baseUrl: 'https://api.example.com', model: 'mercury-flash' } },
  } as MercuryConfig;
}

beforeEach(() => {
  mocks.loadConfig.mockReset();
  mocks.saveConfig.mockReset();
  mocks.updateConfig.mockReset();
  mocks.updateConfig.mockImplementation((mutator: (value: MercuryConfig) => void) => {
    const value = mocks.loadConfig();
    mutator(value);
    mocks.saveConfig(value);
    return value;
  });
  mocks.refreshToken.mockReset();
  mocks.redeemAgentApiKey.mockReset();
});

describe('CloudTokenStore', () => {
  it('updates the live config and persists every single-use rotation', async () => {
    const live = config();
    mocks.loadConfig.mockReturnValue(config());
    mocks.refreshToken.mockResolvedValue({ jwt: 'new-jwt', refreshToken: 'new-refresh' });
    const store = new CloudTokenStore('old-jwt', 'old-refresh', live.cloud.apiUrl, live.cloud.agentId, live);

    await expect(store.rotate()).resolves.toEqual({ jwt: 'new-jwt', refreshToken: 'new-refresh' });

    expect(live.cloud).toMatchObject({ jwt: 'new-jwt', refreshToken: 'new-refresh' });
    expect(live.providers.mercuryCloud.apiKey).toBe('new-jwt');
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      cloud: expect.objectContaining({ jwt: 'new-jwt', refreshToken: 'new-refresh' }),
    }));
  });

  it('adopts credentials rotated and persisted by another process', async () => {
    const live = config();
    mocks.loadConfig
      .mockReturnValueOnce(config())
      .mockReturnValue(config('other-jwt', 'other-refresh'));
    mocks.refreshToken.mockRejectedValue(new Error('Token refresh failed: 401'));
    const store = new CloudTokenStore('old-jwt', 'old-refresh', live.cloud.apiUrl, live.cloud.agentId, live);

    await expect(store.rotate()).resolves.toEqual({ jwt: 'other-jwt', refreshToken: 'other-refresh' });
    expect(store.getTokens()).toEqual({ jwt: 'other-jwt', refreshToken: 'other-refresh' });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('coalesces concurrent rotation requests', async () => {
    const live = config();
    mocks.loadConfig.mockReturnValue(config());
    mocks.refreshToken.mockResolvedValue({ jwt: 'new-jwt', refreshToken: 'new-refresh' });
    const store = new CloudTokenStore('old-jwt', 'old-refresh', live.cloud.apiUrl, live.cloud.agentId, live);

    await Promise.all([store.rotate(), store.rotate(), store.rotate()]);

    expect(mocks.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not restore tokens when disconnect wins an in-flight refresh race', async () => {
    let resolveRefresh!: (tokens: { jwt: string; refreshToken: string }) => void;
    const live = config();
    const disconnected = config('', '');
    disconnected.cloud.enabled = false;
    disconnected.cloud.agentId = '';
    disconnected.providers.mercuryCloud.enabled = false;
    mocks.loadConfig.mockReturnValueOnce(config()).mockReturnValue(disconnected);
    mocks.refreshToken.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const store = new CloudTokenStore('old-jwt', 'old-refresh', live.cloud.apiUrl, live.cloud.agentId, live, live.cloud.agentApiKey);

    const rotating = store.rotate();
    resolveRefresh({ jwt: 'resurrected-jwt', refreshToken: 'resurrected-refresh' });

    await expect(rotating).rejects.toThrow('disconnected or re-paired');
    expect(live.cloud.jwt).toBe('old-jwt');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.redeemAgentApiKey).not.toHaveBeenCalled();
  });

  it('rejects an agent API key that redeems to another agent', async () => {
    const live = config('expired-jwt', '');
    mocks.redeemAgentApiKey.mockResolvedValue({
      jwt: 'other-jwt',
      refreshToken: 'other-refresh',
      agentId: 'agent-2',
    });
    const store = new CloudTokenStore('expired-jwt', '', live.cloud.apiUrl, live.cloud.agentId, live, live.cloud.agentApiKey);

    await expect(store.rotate()).rejects.toThrow('identity mismatch');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});
