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
  getCloudTokenStore: vi.fn(),
  clearCloudTokenStore: vi.fn(),
  getDaemonStatus: vi.fn(),
  getForegroundRuntimeStatus: vi.fn(),
  stopDaemon: vi.fn(),
  stopForegroundRuntime: vi.fn(),
  startBackground: vi.fn(),
  isServiceInstalled: vi.fn(),
  isServiceRunning: vi.fn(),
  restartService: vi.fn(),
  stopService: vi.fn(),
  clearCloudRuntimeOnline: vi.fn(),
  isCloudRuntimeOnline: vi.fn(),
  waitForCloudRuntimeOnline: vi.fn(),
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
  getCloudTokenStore: mocks.getCloudTokenStore,
  clearCloudTokenStore: mocks.clearCloudTokenStore,
}));
vi.mock('../cli/daemon.js', () => ({
  getDaemonStatus: mocks.getDaemonStatus,
  getForegroundRuntimeStatus: mocks.getForegroundRuntimeStatus,
  stopDaemon: mocks.stopDaemon,
  stopForegroundRuntime: mocks.stopForegroundRuntime,
  startBackground: mocks.startBackground,
}));
vi.mock('../cli/service.js', () => ({
  isServiceInstalled: mocks.isServiceInstalled,
  isServiceRunning: mocks.isServiceRunning,
  restartService: mocks.restartService,
  stopService: mocks.stopService,
}));
vi.mock('./runtime-status.js', () => ({
  clearCloudRuntimeOnline: mocks.clearCloudRuntimeOnline,
  isCloudRuntimeOnline: mocks.isCloudRuntimeOnline,
  waitForCloudRuntimeOnline: mocks.waitForCloudRuntimeOnline,
}));

import { runCloudConnect, runCloudDisconnect, runCloudLogin, runCloudPairingFlow } from './pairing-flow.js';

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
  mocks.getForegroundRuntimeStatus.mockReturnValue({ running: false, pid: null });
  mocks.stopForegroundRuntime.mockResolvedValue(true);
  mocks.getCloudTokenStore.mockReturnValue(null);
  mocks.isServiceInstalled.mockReturnValue(false);
  mocks.isServiceRunning.mockReturnValue(false);
  mocks.waitForCloudRuntimeOnline.mockResolvedValue(true);
  mocks.isCloudRuntimeOnline.mockReturnValue(false);
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

  it('refuses to clear credentials while a foreground runtime still holds them', async () => {
    const current = config();
    mocks.loadConfig.mockReturnValue(current);
    mocks.getForegroundRuntimeStatus.mockReturnValue({ running: true, pid: 456 });

    await expect(runCloudDisconnect()).rejects.toThrow('running in the foreground');

    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.clearCloudTokenStore).not.toHaveBeenCalled();
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

describe('runCloudConnect runtime activation', () => {
  it('starts a detached runtime when valid Cloud credentials exist but Mercury is stopped', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await runCloudConnect();

    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    expect(mocks.startBackground).toHaveBeenCalledOnce();
    expect(mocks.waitForCloudRuntimeOnline).toHaveBeenCalledWith('agent-1', 20_000, 'daemon');
    vi.unstubAllGlobals();
  });

  it('does not start a duplicate daemon beside a foreground-only runtime', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.getForegroundRuntimeStatus.mockReturnValue({ running: true, pid: 456 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await expect(runCloudConnect()).rejects.toThrow('running only in the foreground');

    expect(mocks.stopForegroundRuntime).not.toHaveBeenCalled();
    expect(mocks.startBackground).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('accepts an already-online foreground Cloud WebSocket without starting a daemon', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.getForegroundRuntimeStatus.mockReturnValue({ running: true, pid: 456 });
    mocks.isCloudRuntimeOnline.mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await runCloudConnect();

    expect(mocks.startBackground).not.toHaveBeenCalled();
    expect(mocks.restartService).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not reuse an old foreground WebSocket after credentials rotate', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.refreshToken.mockResolvedValue({ jwt: 'fresh-jwt', refreshToken: 'fresh-refresh' });
    mocks.getForegroundRuntimeStatus.mockReturnValue({ running: true, pid: 456 });
    mocks.isCloudRuntimeOnline.mockReturnValue(true);

    await expect(runCloudLogin()).rejects.toThrow('running only in the foreground');

    expect(mocks.startBackground).not.toHaveBeenCalled();
  });

  it('does not claim online status until the Cloud WebSocket is ready', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.waitForCloudRuntimeOnline.mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await expect(runCloudConnect()).rejects.toThrow('WebSocket did not become online');
    vi.unstubAllGlobals();
  });

  it('restarts a running runtime after fresh pairing', async () => {
    const current = config();
    mocks.loadConfig.mockReturnValue(current);
    mocks.getDaemonStatus.mockReturnValue({ running: true, pid: 123 });
    mocks.stopDaemon.mockResolvedValue(true);
    mocks.startPairingFlow.mockResolvedValue({ code: 'pair-code', pairingUrl: 'https://pair.example.com' });
    mocks.pollPairingComplete.mockResolvedValue({
      jwt: 'new-jwt',
      refreshToken: 'new-refresh',
      agentId: 'agent-2',
      tier: 'free',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));

    await runCloudConnect();

    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(mocks.startBackground).toHaveBeenCalledOnce();
    expect(mocks.stopDaemon.mock.invocationCallOrder[0]).toBeLessThan(mocks.startBackground.mock.invocationCallOrder[0]);
    expect(mocks.waitForCloudRuntimeOnline).toHaveBeenCalledWith('agent-2', 20_000, 'daemon');
    vi.unstubAllGlobals();
  });

  it('restarts an installed system service instead of spawning a duplicate daemon', async () => {
    const current = config();
    mocks.loadConfig.mockReturnValue(current);
    mocks.isServiceInstalled.mockReturnValue(true);
    mocks.startPairingFlow.mockResolvedValue({ code: 'pair-code', pairingUrl: 'https://pair.example.com' });
    mocks.pollPairingComplete.mockResolvedValue({
      jwt: 'new-jwt',
      refreshToken: 'new-refresh',
      agentId: 'agent-2',
      tier: 'free',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));

    await runCloudConnect();

    expect(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.startBackground).not.toHaveBeenCalled();
    expect(mocks.waitForCloudRuntimeOnline).toHaveBeenCalledWith('agent-2', 20_000, 'daemon');
    vi.unstubAllGlobals();
  });
});

describe('runCloudLogin runtime activation', () => {
  it('restarts Mercury after rotating the single-use refresh token', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.refreshToken.mockResolvedValue({ jwt: 'fresh-jwt', refreshToken: 'fresh-refresh' });
    mocks.getDaemonStatus.mockReturnValue({ running: true, pid: 123 });
    mocks.stopDaemon.mockResolvedValue(true);

    await runCloudLogin();

    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(mocks.startBackground).toHaveBeenCalledOnce();
  });

  it('reports runtime activation failure without retrying authentication', async () => {
    const current = config();
    current.cloud.enabled = true;
    mocks.loadConfig.mockReturnValue(current);
    mocks.refreshToken.mockResolvedValue({ jwt: 'fresh-jwt', refreshToken: 'fresh-refresh' });
    mocks.getDaemonStatus.mockReturnValue({ running: true, pid: 123 });
    mocks.stopDaemon.mockResolvedValue(false);

    await expect(runCloudLogin()).rejects.toThrow('could not be restarted');
    expect(mocks.refreshToken).toHaveBeenCalledOnce();
  });
});
