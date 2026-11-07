import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { buildContent, verifyContent, contentAssets, inspectArchive } = require('../scripts/release-content.cjs');
const root = resolve(import.meta.dirname, '..');
let dir: string;

// Minimal valid ustar header; lets us test hostile archives without extracting them.
function tarMember(name: string, type = '0', data = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  const sum = [...header].reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function archive(...members: Buffer[]) {
  const file = join(dir, 'hostile.tgz');
  writeFileSync(file, gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
  return file;
}
function checksums(assets: string[]) {
  writeFileSync(join(dir, 'checksums.txt'), assets.map((name) => `${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}  ${name}`).join('\n') + '\n');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mercury-release-content-'));
  // CI normally builds after tests; a clean checkout still exercises the built
  // canonical packer. This builds JS only, never any standalone binary.
  if (!existsSync(join(root, 'dist', 'index.js'))) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe', timeout: 120_000 });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('safe archive inspection', () => {
  it.each(['../escape', '/absolute', 'C:/drive', 'a\\b', 'a/../escape', 'a//b'])('rejects unsafe path %s', (name) => {
    expect(() => inspectArchive(archive(tarMember(name)))).toThrow(/Unsafe archive path/);
  });
  it.each(['1', '2', '3', '4', '6', 'L', 'g'])('rejects link/special/extension type %s', (type) => {
    expect(() => inspectArchive(archive(tarMember('safe', type)))).toThrow(/Unsafe tar member type/);
  });
  it('rejects duplicate paths', () => {
    expect(() => inspectArchive(archive(tarMember('same'), tarMember('same')))).toThrow(/Duplicate/);
  });
  it('checks effective PAX paths', () => {
    const record = Buffer.from('22 path=../escape.txt\n');
    expect(() => inspectArchive(archive(tarMember('pax', 'x', record), tarMember('safe')))).toThrow(/Unsafe archive path/);
  });
  it('rejects corrupt header checksums', () => {
    const member = tarMember('safe');
    member[0] = 65;
    expect(() => inspectArchive(archive(member))).toThrow(/checksum/);
  });
});

describe('portable content built by the real Mercury CLI', () => {
  it('packs all skills, legal notices, and both installable plugins with community pins', () => {
    const assets: string[] = buildContent(root, dir);
    expect(assets.map((p: string) => p.split('/').pop())).toEqual(contentAssets(root));
    const skills = inspectArchive(join(dir, 'mercury-adapted-skills.tgz'));
    for (const name of ['LICENSE', 'README.md', 'verification-before-completion/SKILL.md', 'skill-install-security-gate/SKILL.md']) {
      expect(skills.has(`mercury-adapted/${name}`)).toBe(true);
    }
    expect([...skills.keys()].filter((n: string) => n.endsWith('/SKILL.md'))).toHaveLength(39);
    verifyContent(root, dir);
    const catalog = JSON.parse(readFileSync(join(dir, 'mercury-community-plugins.json'), 'utf8'));
    expect(catalog.plugins.map((e: { tier: string }) => e.tier)).toEqual(['community', 'community']);
    for (const entry of catalog.plugins) {
      const entries = inspectArchive(join(dir, `${entry.id}-${entry.version}.tgz`));
      for (const name of ['LICENSE', 'README.md', 'index.mjs', 'mercury-plugin.json']) expect(entries.has(name)).toBe(true);
    }
  });
  it('rejects official promotion and incorrect pins', () => {
    const file = join(dir, 'mercury-community-plugins.json');
    const original = readFileSync(file);
    const catalog = JSON.parse(original.toString());
    catalog.plugins[0].tier = 'official';
    writeFileSync(file, JSON.stringify(catalog));
    expect(() => verifyContent(root, dir)).toThrow(/Invalid pinned community entry/);
    catalog.plugins[0].tier = 'community';
    catalog.plugins[0].artifact.sha256 = '0'.repeat(64);
    writeFileSync(file, JSON.stringify(catalog));
    expect(() => verifyContent(root, dir)).toThrow(/Invalid pinned community entry/);
    writeFileSync(file, original);
  });
  it('verifies a complete standalone asset set without compiling binaries', () => {
    rmSync(join(dir, 'hostile.tgz'), { force: true });
    const binaries = ['mercury-macos-arm64', 'mercury-macos-x64', 'mercury-linux-x64', 'mercury-linux-x64-baseline', 'mercury-linux-arm64', 'mercury-win-x64.exe', 'mercury-win-x64-baseline.exe'];
    for (const name of binaries) writeFileSync(join(dir, name), 'fixture binary');
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<html></html>');
    execFileSync('tar', ['-czf', join(dir, 'web.tar.gz'), '-C', dir, 'web']);
    rmSync(web, { recursive: true });
    const assets = [...binaries, 'web.tar.gz', ...contentAssets(root)];
    checksums(assets);
    const output = execFileSync(process.execPath, ['scripts/verify-standalone-release.cjs', dir], { cwd: root, encoding: 'utf8' });
    expect(output).toContain('verified 12 standalone release assets');
    const plugin = assets.find((n) => n.startsWith('hardlight-'))!;
    const original = readFileSync(join(dir, plugin));
    writeFileSync(join(dir, plugin), 'tampered');
    expect(() => execFileSync(process.execPath, ['scripts/verify-standalone-release.cjs', dir], { cwd: root, stdio: 'pipe' })).toThrow();
    writeFileSync(join(dir, plugin), original);
  });
  it('generates dev pins only when explicitly requested', () => {
    buildContent(root, dir, { dev: true });
    verifyContent(root, dir, { dev: true });
    expect(() => verifyContent(root, dir)).toThrow(/Invalid pinned community entry/);
  });
});
