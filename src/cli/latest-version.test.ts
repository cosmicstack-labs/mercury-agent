import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDevVersionFromReleaseName, parseVersionFromReleaseLocation } from './latest-version.js';

describe('latest version resolution (mercury upgrade is a no-op when current)', () => {
  it('reads the stable version from the /releases/latest redirect', () => {
    expect(parseVersionFromReleaseLocation('https://github.com/cosmicstack-labs/mercury-agent/releases/tag/v1.3.5')).toBe('1.3.5');
    expect(parseVersionFromReleaseLocation('https://github.com/x/y/releases/tag/1.4.0/')).toBe('1.4.0');
    expect(parseVersionFromReleaseLocation('https://github.com/x/y/releases')).toBeNull();
    expect(parseVersionFromReleaseLocation(null)).toBeNull();
  });

  it('reads the dev version from the rolling release title', () => {
    expect(parseDevVersionFromReleaseName('Mercury Dev — 1.3.1-dev.20261011.d40a112')).toBe('1.3.1-dev.20261011.d40a112');
    expect(parseDevVersionFromReleaseName('Mercury Dev')).toBeNull();
  });

  it('the launcher checks the newest version before stopping anything; only --force reinstalls the same one', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
    const cmd = index.slice(index.indexOf(".command('upgrade')"), index.indexOf(".command('upgrade')") + 1200);
    expect(cmd).toContain("'--force'");
    expect(cmd).toContain('runUpgrade(');
    const cli = readFileSync(join(here, 'upgrade-cli.ts'), 'utf8').replace(/\r\n/g, '\n');
    const run = cli.slice(cli.indexOf('export async function runUpgrade('));
    const check = run.indexOf('serverUpdateStatus(');
    const reinstall = run.indexOf('legacyReinstall()');
    const update = run.indexOf('updateViaRunning(');
    expect(check).toBeGreaterThan(0);
    expect(reinstall).toBeGreaterThan(check);
    expect(update).toBeGreaterThan(check);
    expect(run).toContain('Already on the newest');
    expect(run.slice(0, reinstall)).toContain('if (opts.force)');
  });
});
