import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(prebuiltUi = false) {
  const root = mkdtempSync(join(tmpdir(), 'mercury post build '));
  roots.push(root);
  const write = (name: string, contents: string) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  write('dist/mercury.js', '// __mercuryFrameGate __mercuryCursorAnchor maxLiveRows setCommitTick vendored: true');
  write('src/web/static/fixture.txt', 'static asset');
  write('node_modules/sql.js/dist/sql-wasm.wasm', 'fixture wasm');
  write('ui/package.json', JSON.stringify({ name: 'mercury-build-fixture', private: true, version: '0.0.0' }));
  write('ui/node_modules/vite/package.json', JSON.stringify({ name: 'vite', version: '0.0.0', bin: 'cli.cjs' }));
  // Real npx invokes a real child process, with no package downloads. This
  // fixture substitutes Vite's output, not execSync or the post-build script.
  write('ui/node_modules/vite/cli.cjs', `
    const fs = require('node:fs');
    fs.writeFileSync('vite-invoked.json', JSON.stringify(process.argv.slice(2)));
    process.stdout.write('fixture Vite stdout\\n');
    process.stderr.write('fixture Vite diagnostic\\n');
    if (process.env.FIXTURE_VITE_FAIL === 'before') process.exit(73);
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.html', 'fresh UI');
    fs.writeFileSync('dist/app.js', 'fresh script');
    if (process.env.FIXTURE_VITE_FAIL === 'after') process.exit(73);
  `);
  write('ui/node_modules/.bin/vite', '#!/usr/bin/env node\nrequire("../vite/cli.cjs");\n');
  // npm uses a command shim on Windows; no symlink privilege is required.
  write('ui/node_modules/.bin/vite.cmd', `@echo off\r\n"${process.execPath}" "%~dp0\\..\\vite\\cli.cjs" %*\r\n`);
  const vite = join(root, 'ui/node_modules/.bin/vite');
  if (process.platform !== 'win32') chmodSync(vite, 0o755);
  if (prebuiltUi) write('ui/dist/index.html', 'previous UI');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const script = join(root, 'scripts/post-build.cjs');
  copyFileSync(fileURLToPath(new URL('./post-build.cjs', import.meta.url)), script);
  return { root, script, destination: join(root, 'dist/web/ui') };
}

function run(f: ReturnType<typeof fixture>, options: { fail?: 'before' | 'after'; termux?: boolean } = {}) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const existingPath = env[pathKey] ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${dirname(process.execPath)}${delimiter}${existingPath}`;
  delete env.TERMUX_VERSION;
  if (options.termux) env.TERMUX_VERSION = 'fixture';
  env.FIXTURE_VITE_FAIL = options.fail ?? '';
  env.npm_config_offline = 'true';
  env.npm_config_cache = join(f.root, 'npm-cache');
  env.npm_config_update_notifier = 'false';
  return spawnSync(process.execPath, [f.script], { cwd: f.root, env, encoding: 'utf8', timeout: 20_000 });
}

// Physical Termux devices intentionally do not run Vite, even when the env
// flag is absent. That platform's skip contract is tested below.
const onTermuxDevice = existsSync('/data/data/com.termux');

describe('post-build UI result', () => {
  it.skipIf(onTermuxDevice).each(['before', 'after'] as const)('fails on a nonzero Vite exit %s output, even when index.html exists', (phase) => {
    const f = fixture(phase === 'before');
    if (phase === 'after') {
      mkdirSync(f.destination, { recursive: true });
      writeFileSync(join(f.destination, 'index.html'), 'last successful packaged UI');
    }
    const result = run(f, { fail: phase });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(f.root, 'ui/vite-invoked.json'), 'utf8'))).toEqual(['build']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fixture Vite stdout');
    expect(result.stderr).toContain('fixture Vite diagnostic');
    expect(result.stderr).toContain('ERROR: Vite build failed (exit 73)');
    expect(result.stdout).not.toContain('Build complete');
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe(phase === 'before' ? 'previous UI' : 'fresh UI');
    if (phase === 'before') expect(existsSync(f.destination)).toBe(false);
    else expect(readFileSync(join(f.destination, 'index.html'), 'utf8')).toBe('last successful packaged UI');
    expect(existsSync(join(f.destination, 'app.js'))).toBe(false);
    expect(existsSync(join(f.destination, 'sw.js'))).toBe(false);
  });

  it.skipIf(onTermuxDevice)('copies the successful build and writes the service worker cleanup', () => {
    const f = fixture(true);
    const result = run(f);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Build complete');
    expect(readFileSync(join(f.destination, 'index.html'), 'utf8')).toBe('fresh UI');
    expect(readFileSync(join(f.destination, 'app.js'), 'utf8')).toBe('fresh script');
    expect(readFileSync(join(f.destination, 'sw.js'), 'utf8')).toContain('self.registration.unregister()');
    expect(readFileSync(join(f.root, 'dist/web/static/vendor/sql-wasm.wasm'), 'utf8')).toBe('fixture wasm');
  });

  it.each([false, true])('preserves the intentional Termux skip (prebuilt UI: %s)', (prebuiltUi) => {
    const f = fixture(prebuiltUi);
    const result = run(f, { fail: 'before', termux: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Skipping UI build on Termux');
    expect(existsSync(join(f.root, 'ui/vite-invoked.json'))).toBe(false);
    if (prebuiltUi) expect(readFileSync(join(f.destination, 'index.html'), 'utf8')).toBe('previous UI');
    else expect(existsSync(f.destination)).toBe(false);
  });
});
