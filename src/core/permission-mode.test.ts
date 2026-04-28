import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager } from '../capabilities/permissions.js';
import { applySessionPermissionMode } from './permission-mode.js';

const mercuryHomes: string[] = [];
const originalMercuryHome = process.env.MERCURY_HOME;

function createPermissionManager(): PermissionManager {
  const mercuryHome = mkdtempSync(join(tmpdir(), 'mercury-permission-mode-'));
  mercuryHomes.push(mercuryHome);
  process.env.MERCURY_HOME = mercuryHome;
  return new PermissionManager();
}

afterEach(() => {
  for (const mercuryHome of mercuryHomes.splice(0)) {
    rmSync(mercuryHome, { recursive: true, force: true });
  }

  if (originalMercuryHome === undefined) {
    delete process.env.MERCURY_HOME;
  } else {
    process.env.MERCURY_HOME = originalMercuryHome;
  }
});

describe('applySessionPermissionMode', () => {
  it('enables auto-approve for the provided channel without granting filesystem scope', () => {
    const permissions = {
      setCurrentChannel: vi.fn(),
      setAutoApproveAll: vi.fn(),
      addTempScope: vi.fn(),
    };

    applySessionPermissionMode('allow-all', 'telegram:1', 'telegram', permissions);

    expect(permissions.setCurrentChannel).toHaveBeenCalledWith('telegram:1', 'telegram');
    expect(permissions.setAutoApproveAll).toHaveBeenCalledWith(true);
    expect(permissions.addTempScope).not.toHaveBeenCalled();
  });

  it('applies the mode only to the target channel', () => {
    const permissions = createPermissionManager();

    applySessionPermissionMode('allow-all', 'telegram:1', 'telegram', permissions);

    permissions.setCurrentChannel('telegram:1', 'telegram');
    expect(permissions.isAutoApproveAll()).toBe(true);

    permissions.setCurrentChannel('telegram:2', 'telegram');
    expect(permissions.isAutoApproveAll()).toBe(false);
  });

  it('does nothing when mode is undefined', () => {
    const permissions = {
      setCurrentChannel: vi.fn(),
      setAutoApproveAll: vi.fn(),
      addTempScope: vi.fn(),
    };

    applySessionPermissionMode(undefined, 'telegram:1', 'telegram', permissions);

    expect(permissions.setCurrentChannel).not.toHaveBeenCalled();
    expect(permissions.setAutoApproveAll).not.toHaveBeenCalled();
    expect(permissions.addTempScope).not.toHaveBeenCalled();
  });
});
