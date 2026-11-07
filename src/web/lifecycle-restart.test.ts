import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import lifecycle, { setRestartSpawner } from './api/lifecycle.js';

/**
 * A dashboard save (providers, keys, default model) is durable but the
 * runtime reads it at boot; `mercury doctor` had the same gap. The runtime
 * must offer the restart and the CLI must do it when the file changed.
 */
describe('POST /api/restart', () => {
  it('asks the owner from another device, and hands off to a detached restart here', async () => {
    let spawned = 0;
    setRestartSpawner(() => { spawned++; return true; });
    const remote = await lifecycle.request('http://127.0.0.1:6174/api/restart', { method: 'POST' }, { incoming: { socket: { remoteAddress: '10.0.0.7' } } });
    expect(remote.status).toBe(428);
    expect(spawned).toBe(0);
    const local = await lifecycle.request('http://127.0.0.1:6174/api/restart', { method: 'POST' }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(local.status).toBe(202);
    expect(spawned).toBe(1);
    setRestartSpawner(() => false);
    const failed = await lifecycle.request('http://127.0.0.1:6174/api/restart', { method: 'POST' }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(failed.status).toBe(503);
  });

  it('mercury doctor restarts the running daemon when the config changed', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
    const doctor = index.slice(index.indexOf(".command('doctor')"), index.indexOf(".command('status')"));
    expect(doctor).toContain('const before = configFingerprint();');
    expect(doctor).toContain("if (configFingerprint() !== before) {\n      restartDaemonIfRunning(");
  });
});
