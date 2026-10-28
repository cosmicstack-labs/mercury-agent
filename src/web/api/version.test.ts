import { describe, expect, it } from 'vitest';
import status from './status.js';

/**
 * The listener's own version.
 *
 * It answered `""` on every installed instance: the lookup counted `..` segments written for
 * `src/web/api/`, and the shipped bundle runs from `dist/`. A health answer without a version is a
 * version nobody can quote in a bug report.
 */
describe('GET /api/health', () => {
  it('reports this build’s version', async () => {
    // `/api/health` answers loopback only, and `app.request` has no socket unless one is provided.
    const res = await status.request('/api/health', {}, {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    } as never);
    const body = (await res.json()) as { ok: boolean; version?: string };

    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
