import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ running: vi.fn(), stop: vi.fn() }));
vi.mock('../cli/service.js', () => ({ isServiceRunning: mocks.running, stopService: mocks.stop }));
vi.mock('../cli/daemon.js', () => ({
  getDaemonStatus: () => ({ running: false }),
  getForegroundRuntimeStatus: () => ({ running: false }),
}));
import { realWorkerSteps } from './server-updater.js';

describe('updater service stop confirmation', () => {
  beforeEach(() => {
    vi.stubEnv('MERCURY_UPDATE_DRY_RUN', '');
    mocks.running.mockReset();
    mocks.stop.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('does not authorize installation when stopping the service failed', async () => {
    mocks.running.mockReturnValue(true);
    mocks.stop.mockReturnValue(false);
    expect(await realWorkerSteps().stop()).toBe(false);
  });

  it('propagates unavailable service status instead of treating it as stopped', async () => {
    mocks.stop.mockImplementation(() => { throw new Error('Task Scheduler status is unavailable'); });
    await expect(realWorkerSteps().stop()).rejects.toThrow('unavailable');
    expect(mocks.stop).toHaveBeenCalled();
  });

  it('does not bypass stop confirmation for a queued task that is not yet running', async () => {
    mocks.running.mockReturnValue(false);
    mocks.stop.mockReturnValue(false);
    expect(await realWorkerSteps().stop()).toBe(false);
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.running).not.toHaveBeenCalled();
  });

  it('accepts a confirmed service stop', async () => {
    mocks.running.mockReturnValue(true);
    mocks.stop.mockReturnValue(true);
    expect(await realWorkerSteps().stop()).toBe(true);
  });
});
