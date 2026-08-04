import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MercuryConfig } from '../utils/config.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
  startPairingFlow: vi.fn(),
  pollPairingComplete: vi.fn(),
  refreshToken: vi.fn(),
  redeemAgentApiKey: vi.fn(),
  openUrl: vi.fn(),
  initCloudTokenStore: vi.fn(),
  clearCloudTokenStore: vi.fn(),
  getDaemonStatus: vi.fn(),
  stopDaemon: vi.fn(),
  startBackground: vi.fn(),
}));

vi.mock('../utils/config.js', () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
  updateConfig: mocks.updateConfig,
}));
vi.mock('./pairing.js', () => ({
  PairingFailureError: class PairingFailureError extends Error {
    constructor(message: string, public readonly details: Record<string, unknown> = {}) {
      super(message);
    }
  },
  startPairingFlow: mocks.startPairingFlow,
  pollPairingComplete: mocks.pollPairingComplete,
  refreshToken: mocks.refreshToken,
  redeemAgentApiKey: mocks.redeemAgentApiKey,
}));
vi.mock('../utils/open-url.js', () => ({ openUrl: mocks.openUrl }));
vi.mock('./token-store.js', () => ({
  initCloudTokenStore: mocks.initCloudTokenStore,
  clearCloudTokenStore: mocks.clearCloudTokenStore,
}));
vi.mock('../cli/daemon.js', () => ({
  getDaemonStatus: mocks.getDaemonStatus,
  stopDaemon: mocks.stopDaemon,
  startBackground: mocks.startBackground,
}));

import { runCloudDisconnect, runCloudPairingFlow } from './pairing-flow.js';

function config(): MercuryConfig {
  return {
    cloud: {
      enabled: false,
      apiUrl: 'https://api.example.com',
      wsUrl: 'wss://api.example.com/ws',
      jwt: 'stale-jwt',
      refreshToken: 'stale-refresh',
      agentId: 'agent-1',
      tier: 'free',
      agentApiKey: 'mcapk_old',
    },
    providers: {
      default: 'mercuryCloud',
      mercuryCloud: {
        name: 'mercuryCloud',
        enabled: true,
        apiKey: 'stale-jwt',
        baseUrl: 'https://api.example.com',
        model: 'mercury-flash',
      },
      deepseek: {
        name: 'deepseek',
        enabled: true,
        apiKey: 'local-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      },
    },
  } as MercuryConfig;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getDaemonStatus.mockReturnValue({ running: false, pid: null });
  mocks.updateConfig.mockImplementation((mutator: (value: MercuryConfig) => void) => {
    const value = mocks.loadConfig();
    mutator(value);
    mocks.saveConfig(value);
    return value;
  });
  mocks.openUrl.mockResolvedValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runCloudDisconnect', () => {
  it('stops the daemon first and scrubs stale credentials even when Cloud is marked disabled', async () => {
    const current = config();
    mocks.loadConfig.mockReturnValue(current);
    mocks.getDaemonStatus.mockReturnValue({ running: true, pid: 123 });
    mocks.stopDaemon.mockResolvedValue(true);

    await runCloudDisconnect();

    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      cloud: expect.objectContaining({
        enabled: false,
        jwt: '',
        refreshToken: '',
        agentId: '',
        agentApiKey: '',
      }),
    }));
    expect(current.providers.mercuryCloud).toMatchObject({ enabled: false, apiKey: '' });
    expect(current.providers.default).toBe('deepseek');
    expect(mocks.clearCloudTokenStore).toHaveBeenCalledOnce();
    expect(mocks.startBackground).toHaveBeenCalledOnce();
    expect(mocks.stopDaemon.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveConfig.mock.invocationCallOrder[0]);
  });
});

describe('runCloudPairingFlow', () => {
  it('never carries an old agent API key into a newly paired identity', async () => {
    const current = config();
    mocks.startPairingFlow.mockResolvedValue({ code: 'pair-code', pairingUrl: 'https://pair.example.com' });
    mocks.pollPairingComplete.mockResolvedValue({
      jwt: 'new-jwt',
      refreshToken: 'new-refresh',
      agentId: 'agent-2',
      tier: 'free',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));

    const result = await runCloudPairingFlow(current);

    expect(result?.cloudConfig).toMatchObject({ agentId: 'agent-2', agentApiKey: '' });
    vi.unstubAllGlobals();
  });
});
