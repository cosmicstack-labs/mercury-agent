import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isStandaloneBinary } from '../cli/daemon.js';
import { isDevBuild } from '../utils/dev-build.js';

/**
 * How this Mercury was installed, which decides how it updates:
 *
 *  - binary: the one-file build from the installer (~/.mercury/bin/mercury):
 *    download the release asset, check its checksum, swap it in;
 *  - npm: a global npm install: `npm i -g` the exact version;
 *  - source: a git checkout — updating is `git pull` and a build, which
 *    Mercury won't do to someone's working tree;
 *  - unknown: anything else (a project-local install, an unusual runtime).
 */

export type InstallKind = 'binary' | 'npm' | 'source' | 'unknown';

export interface InstallInfo {
  kind: InstallKind;
  channel: 'stable' | 'dev';
  canSelfUpdate: boolean;
  cannotReason?: string;
  /** binary: the executable to replace. */
  binaryPath?: string;
  /** npm: the package directory. */
  packageDir?: string;
}

export const NPM_PACKAGE = '@cosmicstack/mercury-agent';

function findUp(start: string, name: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, name))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function isGlobalNpmPath(p: string): boolean {
  const n = p.split(sep).join('/');
  // POSIX prefixes put globals in <prefix>/lib/node_modules; Windows in %AppData%\npm\node_modules; nvm/volta/fnm keep the same shapes.
  return /\/lib\/node_modules\/@cosmicstack\/mercury-agent\//.test(n) || /\/npm\/node_modules\/@cosmicstack\/mercury-agent\//i.test(n);
}

export function detectInstall(version: string, opts: { script?: string; execPath?: string; standalone?: boolean } = {}): InstallInfo {
  const channel = isDevBuild(version) ? 'dev' : 'stable';
  const forced = process.env.MERCURY_INSTALL_KIND as InstallKind | undefined;
  const standalone = opts.standalone ?? isStandaloneBinary();
  const execPath = opts.execPath ?? process.execPath;
  const script = opts.script ?? process.argv[1] ?? '';

  if (forced === 'binary' || (!forced && standalone)) {
    return { kind: 'binary', channel, canSelfUpdate: true, binaryPath: execPath };
  }
  if (forced === 'npm' || (!forced && script && isGlobalNpmPath(script))) {
    const n = script.split(sep).join('/');
    const at = n.indexOf('/@cosmicstack/mercury-agent/');
    const packageDir = at >= 0 ? script.slice(0, at + '/@cosmicstack/mercury-agent'.length) : undefined;
    return { kind: 'npm', channel, canSelfUpdate: true, packageDir };
  }
  if (forced === 'source' || (!forced && script && findUp(dirname(script), '.git'))) {
    return { kind: 'source', channel, canSelfUpdate: false, cannotReason: 'This Mercury runs from a source checkout. Update it with git pull and a build.' };
  }
  if (script.includes(`${sep}node_modules${sep}`) || script.includes('/node_modules/')) {
    return { kind: 'unknown', channel, canSelfUpdate: false, cannotReason: 'This Mercury is installed inside a project, not globally. Update it with that project\'s package manager.' };
  }
  return { kind: 'unknown', channel, canSelfUpdate: false, cannotReason: 'Mercury can\'t tell how it was installed, so it won\'t update itself. Reinstall from mercuryagent.sh.' };
}
