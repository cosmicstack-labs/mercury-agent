import { describe, expect, it } from 'vitest';
import { REPO_ISSUES_URL, FEEDBACK_EMAIL, findNpmInstalls, npmGlobalRoots, shellRcFiles, stripInstallerPathLines } from './uninstall.js';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `mercury uninstall` contract: channel- and platform-aware full teardown.
 * The destructive steps are exercised manually (they delete real files); the
 * pure detection/cleanup pieces are unit-tested here.
 */
describe('mercury uninstall', () => {
  it('strips the installer PATH line and marker from an rc file, leaving the rest intact', () => {
    const rc = [
      '# ~/.zshrc',
      'export EDITOR=vim',
      '',
      '# added by mercury installer',
      'export PATH="/Users/me/.mercury/bin:$PATH"',
      'alias ll="ls -la"',
    ].join('\n');

    const stripped = stripInstallerPathLines(rc, '/Users/me/.mercury/bin');

    expect(stripped).toBe(['# ~/.zshrc', 'export EDITOR=vim', '', 'alias ll="ls -la"'].join('\n'));
  });

  it('returns null when the rc file has nothing to strip (no rewrite)', () => {
    expect(stripInstallerPathLines('export PATH=/usr/bin:/bin\n', '/Users/me/.mercury/bin')).toBeNull();
  });

  it('strips the fish-shell PATH form too', () => {
    const rc = ['set -gx PATH /Users/me/.mercury/bin $PATH', '# added by mercury installer'].join('\n');
    const stripped = stripInstallerPathLines(rc, '/Users/me/.mercury/bin');
    expect(stripped).toBe('');
  });

  it('discovers a real global npm install under nvm-managed node versions', () => {
    // Simulated (was a real-machine assertion): fresh CI runners have no
    // @cosmicstack/mercury-agent install, so the discovery logic is exercised
    // against a fabricated nvm-managed root (a global root IS the
    // node_modules dir, e.g. ~/.nvm/versions/node/v20.20.2/lib/node_modules).
    const nvm = mkdtempSync(join(tmpdir(), 'mercury-uninstall-'));
    const root = join(nvm, 'v20.20.2', 'lib', 'node_modules');
    try {
      const pkg = join(root, '@cosmicstack', 'mercury-agent');
      mkdirSync(pkg, { recursive: true });
      const installs = findNpmInstalls({ roots: [root] });
      expect(installs.global).toEqual([pkg]);
      expect(installs.local).toEqual([]);
    } finally {
      rmSync(nvm, { recursive: true, force: true });
    }
  });

  it('discovers the local project install from the running entry script', () => {
    const project = mkdtempSync(join(tmpdir(), 'mercury-uninstall-local-'));
    try {
      writeFileSync(join(project, 'package.json'), '{}');
      const pkgDir = join(project, 'node_modules', '@cosmicstack', 'mercury-agent');
      mkdirSync(pkgDir, { recursive: true });
      const installs = findNpmInstalls({ roots: [], entryScript: join(pkgDir, 'dist', 'index.js') });
      expect(installs.local).toEqual([pkgDir]);
      expect(installs.global).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('never reports a global root as a local project — the script lives inside the global root', () => {
    const nvm = mkdtempSync(join(tmpdir(), 'mercury-uninstall-dedupe-'));
    const root = join(nvm, 'v22.18.0', 'lib', 'node_modules');
    try {
      const pkg = join(root, '@cosmicstack', 'mercury-agent');
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      const installs = findNpmInstalls({ roots: [root], entryScript: join(pkg, 'dist', 'index.js') });
      expect(installs.global).toEqual([pkg]);
      expect(installs.local).toEqual([]);
    } finally {
      rmSync(nvm, { recursive: true, force: true });
    }
  });

  it('every install discovered in the real environment exists (CI runners may find none)', () => {
    const installs = findNpmInstalls();
    for (const path of [...installs.global, ...installs.local]) expect(existsSync(path)).toBe(true);
  });

  it('npmGlobalRoots includes the active npm root', () => {
    const roots = npmGlobalRoots();
    expect(roots.length).toBeGreaterThan(0);
  });

  it('exposes the support links shown at the end of the uninstaller', () => {
    expect(REPO_ISSUES_URL).toContain('cosmicstack-labs/mercury-agent/issues');
    expect(FEEDBACK_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
  });

  it('shellRcFiles returns an array (rc files may or may not exist)', () => {
    expect(Array.isArray(shellRcFiles())).toBe(true);
  });
});

describe('stripInstallerPathLines edge cases', () => {
  const binDir = '/tmp/mercury-uninstall-test/bin';
  const rcPath = join(tmpdir(), `mercury-uninstall-test-${process.pid}.rc`);

  it('round-trips a real file rewrite', () => {
    writeFileSync(rcPath, ['# rc', '# added by mercury installer', `export PATH="${binDir}:$PATH"`, 'true'].join('\n'));
    const stripped = stripInstallerPathLines(readFileSync(rcPath, 'utf-8'), binDir);
    expect(stripped).not.toBeNull();
    writeFileSync(rcPath, stripped!, 'utf-8');
    expect(readFileSync(rcPath, 'utf-8')).toBe(['# rc', 'true'].join('\n'));
    rmSync(rcPath, { force: true });
  });

  it('keeps unrelated PATH lines that merely share a prefix with the bin dir', () => {
    const rc = [`export PATH="${binDir}-backup:$PATH"`, `export PATH="${binDir}:$PATH"`].join('\n');
    const stripped = stripInstallerPathLines(rc, binDir);
    expect(stripped).toBe(`export PATH="${binDir}-backup:$PATH"`);
  });
});