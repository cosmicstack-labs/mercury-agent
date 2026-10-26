import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPackage, parseSource, rollbackPackage, sha256File, uninstallPackage, loadManifest } from './installer.js';
import { pluginDataDir, pluginDir, pluginVersionDir, readState, stagingRoot, withLock } from './store.js';
import { inProcessPlugin, tempHome } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
let src: string;

beforeEach(() => {
  env = tempHome();
  src = join(env.home, 'src');
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.restore());

function tgz(dir: string, out: string): string {
  execFileSync('tar', ['-czf', out, '-C', dir, '.']);
  return out;
}

describe('parseSource', () => {
  it('recognises ids, paths, https URLs and github repos', () => {
    expect(parseSource('weather')).toEqual({ kind: 'id', id: 'weather' });
    expect(parseSource('./plugins/weather')).toMatchObject({ type: 'path' });
    expect(parseSource('/tmp/x.tgz')).toMatchObject({ type: 'path', path: resolve('/tmp/x.tgz') });
    expect(parseSource('https://example.com/p.tgz')).toEqual({ type: 'url', url: 'https://example.com/p.tgz' });
    expect(parseSource('github:acme/mercury-weather@v1.2.0')).toEqual({ type: 'github', repo: 'acme/mercury-weather', tag: 'v1.2.0' });
  });
  it('refuses plain http and nonsense', () => {
    expect(() => parseSource('http://example.com/p.tgz')).toThrow(/HTTPS/);
    expect(() => parseSource('Not A Plugin!')).toThrow(/Don't know how/);
  });
});

describe('installPackage', () => {
  it('installs a folder atomically, disabled by default, with a data dir', async () => {
    const dir = inProcessPlugin(src);
    const r = await installPackage({ type: 'path', path: dir });
    expect(r).toMatchObject({ id: 'echo-tools', version: '1.0.0', verified: false, unchanged: false });
    expect(existsSync(join(pluginVersionDir('echo-tools', '1.0.0'), 'index.mjs'))).toBe(true);
    expect(existsSync(pluginDataDir('echo-tools'))).toBe(true);
    expect(readState().plugins['echo-tools']).toMatchObject({ enabled: false, version: '1.0.0', source: { type: 'path' } });
    expect(existsSync(stagingRoot()) ? readdirSync(stagingRoot()) : []).toEqual([]);
  });

  it('installs a .tgz (npm-pack style "package/" root works too)', async () => {
    const dir = inProcessPlugin(src, { id: 'packed' });
    const wrap = join(env.home, 'wrap');
    mkdirSync(join(wrap, 'package'), { recursive: true });
    execFileSync('cp', ['-R', `${dir}/.`, join(wrap, 'package')]);
    const archive = tgz(wrap, join(env.home, 'packed.tgz'));
    const r = await installPackage({ type: 'path', path: archive });
    expect(r.id).toBe('packed');
  });

  it('returns unchanged for the same version unless forced', async () => {
    const dir = inProcessPlugin(src);
    await installPackage({ type: 'path', path: dir });
    expect((await installPackage({ type: 'path', path: dir })).unchanged).toBe(true);
    expect((await installPackage({ type: 'path', path: dir }, { force: true })).unchanged).toBe(false);
  });

  it('rejects packages containing a symlink and leaves nothing behind', async () => {
    const dir = inProcessPlugin(src, { id: 'sneaky' });
    symlinkSync('/etc/passwd', join(dir, 'passwd'));
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/symbolic link/);
    expect(existsSync(pluginDir('sneaky'))).toBe(false);
    expect(readState().plugins.sneaky).toBeUndefined();
    expect(existsSync(stagingRoot()) ? readdirSync(stagingRoot()) : []).toEqual([]);
  });

  it('rejects an invalid manifest with a readable message', async () => {
    const dir = inProcessPlugin(src, { id: 'bad-one', manifest: { kind: 'in-process', entry: '../escape.js' } });
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/Invalid mercury-plugin.json: entry/);
  });

  it('rejects a plugin built for another Mercury version', async () => {
    const dir = inProcessPlugin(src, { id: 'future', engines: { mercury: '>=99.0.0' } });
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/needs Mercury >=99\.0\.0/);
  });

  it('rejects a plugin needing a newer plugin API', async () => {
    const dir = inProcessPlugin(src, { id: 'newapi', engines: { mercury: '>=1.0.0', pluginApi: '^2.0.0' } });
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/plugin API \^2\.0\.0/);
  });

  it('rejects a missing entry module', async () => {
    const dir = inProcessPlugin(src, { id: 'noentry', manifest: { entry: 'missing.mjs' } });
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/Entry module "missing.mjs" is missing/);
  });

  it('verifies declared file checksums', async () => {
    const dir = inProcessPlugin(src, { id: 'summed' });
    const good = await sha256File(join(dir, 'index.mjs'));
    writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify({ ...loadManifest(dir), checksums: { 'index.mjs': good.replace(/^./, good[0] === 'a' ? 'b' : 'a') } }));
    await expect(installPackage({ type: 'path', path: dir })).rejects.toThrow(/Checksum mismatch for index.mjs/);
  });

  it('keeps the previous version for rollback and prunes older ones', async () => {
    await installPackage({ type: 'path', path: inProcessPlugin(src, { version: '1.0.0' }) });
    await installPackage({ type: 'path', path: inProcessPlugin(src, { version: '1.1.0' }) });
    await installPackage({ type: 'path', path: inProcessPlugin(src, { version: '1.2.0' }) });
    expect(readdirSync(join(pluginDir('echo-tools'), 'versions')).sort()).toEqual(['1.1.0', '1.2.0']);
    expect(readState().plugins['echo-tools']).toMatchObject({ version: '1.2.0', previousVersion: '1.1.0' });
    expect(await rollbackPackage('echo-tools')).toEqual({ from: '1.2.0', to: '1.1.0' });
    expect(readState().plugins['echo-tools']).toMatchObject({ version: '1.1.0', previousVersion: '1.2.0' });
  });

  it('uninstall keeps data and settings unless purge is set', async () => {
    await installPackage({ type: 'path', path: inProcessPlugin(src) });
    writeFileSync(join(pluginDataDir('echo-tools'), 'note.txt'), 'keep me');
    await uninstallPackage('echo-tools');
    expect(readState().plugins['echo-tools']).toBeUndefined();
    expect(existsSync(join(pluginDataDir('echo-tools'), 'note.txt'))).toBe(true);
    expect(existsSync(join(pluginDir('echo-tools'), 'versions'))).toBe(false);
    await installPackage({ type: 'path', path: inProcessPlugin(src) });
    await uninstallPackage('echo-tools', true);
    expect(existsSync(pluginDir('echo-tools'))).toBe(false);
  });

  it('the install lock serialises concurrent writers', async () => {
    const order: string[] = [];
    await Promise.all([
      withLock(async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 50)); order.push('a2'); }),
      (async () => { await new Promise((r) => setTimeout(r, 5)); await installPackage({ type: 'path', path: inProcessPlugin(src) }); order.push('b'); })(),
    ]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});
