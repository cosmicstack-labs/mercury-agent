import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('../utils/config.js', () => ({
  getMercuryHome: () => home,
}));

const daemon = await import('./daemon.js');

describe('daemon pid file ownership', () => {
  afterEach(() => {
    if (home && existsSync(home)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets a daemon child claim the pid file with its real pid', () => {
    home = mkdtempSync(join(tmpdir(), 'mercury-daemon-'));

    daemon.writeCurrentPid();

    expect(readFileSync(join(home, 'daemon.pid'), 'utf8')).toBe(String(process.pid));
    expect(daemon.getDaemonStatus()).toMatchObject({ running: true, pid: process.pid });
  });

  it('does not unlink a pid file owned by another daemon process', () => {
    home = mkdtempSync(join(tmpdir(), 'mercury-daemon-'));
    const pidPath = join(home, 'daemon.pid');

    daemon.writeCurrentPid();
    const claimedPid = readFileSync(pidPath, 'utf8');
    expect(claimedPid).toBe(String(process.pid));

    // Simulate another supervised daemon having replaced this process as owner.
    // PID 1 should exist on every supported platform in test environments.
    writeFileSync(pidPath, '1');

    daemon.unlinkPidIfCurrent();

    expect(readFileSync(pidPath, 'utf8')).toBe('1');
  });
});
