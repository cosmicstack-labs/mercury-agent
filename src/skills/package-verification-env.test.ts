import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { packageVerificationEnv } = require('../../scripts/package-verification-env.cjs');

describe('package verification profile isolation', () => {
  it('overrides inherited home, skill-install and plugin settings', () => {
    const temporary = join(tmpdir(), 'verification fixture');
    const inherited = {
      HOME: '/owner', USERPROFILE: '/owner', MERCURY_HOME: '/owner/mercury',
      MERCURY_SKILLS_INSTALL_ROOT: '/owner/custom-skills',
      MERCURY_PLUGINS: 'on', MERCURY_PLUGIN_CATALOG_URL: 'https://example.invalid',
      PATH: '/toolchain',
    };
    const env = packageVerificationEnv(temporary, inherited);
    expect(env.HOME).toBe(temporary);
    expect(env.USERPROFILE).toBe(temporary);
    expect(env.MERCURY_HOME).toBe(join(temporary, 'mercury home'));
    expect(env.MERCURY_SKILLS_INSTALL_ROOT).toBe(join(temporary, 'mercury home', 'skills'));
    expect(env.MERCURY_PLUGINS).toBe('off');
    expect(env.MERCURY_PLUGIN_CATALOG_URL).toBe('off');
    expect(env.PATH).toBe('/toolchain');
    expect(inherited.MERCURY_SKILLS_INSTALL_ROOT).toBe('/owner/custom-skills');
  });
});
