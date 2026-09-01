import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mercuryHome = '';

async function loadConfigModule() {
  vi.resetModules();
  vi.stubEnv('MERCURY_HOME', mercuryHome);
  return import('./config.js');
}

describe('appendToMercuryEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (mercuryHome) {
      rmSync(mercuryHome, { recursive: true, force: true });
      mercuryHome = '';
    }
  });

  it('creates the Mercury home directory and env file on first write', async () => {
    mercuryHome = join(mkdtempSync(join(tmpdir(), 'mercury-config-test-')), 'nested-home');
    const { appendToMercuryEnv } = await loadConfigModule();

    appendToMercuryEnv('GITHUB_TOKEN', 'ghp_test_token');

    const envPath = join(mercuryHome, '.env');
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe('GITHUB_TOKEN=ghp_test_token\n');
    expect(process.env.GITHUB_TOKEN).toBe('ghp_test_token');
  });

  it('replaces an existing key without duplicating unrelated env entries', async () => {
    mercuryHome = mkdtempSync(join(tmpdir(), 'mercury-config-test-'));
    const { appendToMercuryEnv } = await loadConfigModule();

    appendToMercuryEnv('GITHUB_TOKEN', 'ghp_old_token');
    appendToMercuryEnv('SPOTIFY_CLIENT_ID', 'spotify-client');
    appendToMercuryEnv('GITHUB_TOKEN', 'ghp_new_token');

    expect(readFileSync(join(mercuryHome, '.env'), 'utf-8')).toBe(
      'SPOTIFY_CLIENT_ID=spotify-client\nGITHUB_TOKEN=ghp_new_token\n',
    );
  });
});
