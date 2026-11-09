import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GWS_RELEASES,
  GWS_VERSION,
  findGws,
  gwsArchiveName,
  gwsTarget,
  installGws,
  withMercuryGwsOnPath,
} from './gws-binary.js';
import { executeCommand } from '../capabilities/shell/run-command.js';

const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const BSDTAR = (() => {
  try {
    return execFileSync(TAR, ['--version'], { encoding: 'utf8' }).toLowerCase().includes('bsdtar');
  } catch {
    return false;
  }
})();

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mercury-gws-bin-test-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function archive(name: string, file: string, content: string): Buffer {
  const src = join(work, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, file), content);
  const args = name.endsWith('.zip') ? ['-a', '-cf', name, '-C', 'src', file] : ['-czf', name, '-C', 'src', file];
  execFileSync(TAR, args, { cwd: work });
  return readFileSync(join(work, name));
}

function serve(data: Buffer, status = 200): { fetchImpl: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    requested.push(String(url));
    return new Response(status === 200 ? new Uint8Array(data) : 'missing', { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('gws release targets', () => {
  it.each([
    ['darwin', 'arm64', 'gnu', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'gnu', 'x86_64-apple-darwin'],
    ['win32', 'x64', 'gnu', 'x86_64-pc-windows-msvc'],
    ['linux', 'x64', 'gnu', 'x86_64-unknown-linux-gnu'],
    ['linux', 'x64', 'musl', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'gnu', 'aarch64-unknown-linux-gnu'],
    ['linux', 'arm64', 'musl', 'aarch64-unknown-linux-musl'],
  ] as const)('%s %s (%s) uses %s', (platform, arch, libc, target) => {
    expect(gwsTarget(platform, arch, libc)).toBe(target);
  });

  it.each([
    ['win32', 'arm64'],
    ['android', 'arm64'],
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
  ] as const)('%s %s has no release', (platform, arch) => {
    expect(gwsTarget(platform, arch)).toBeNull();
  });

  it('names the archives the way the releases do', () => {
    expect(gwsArchiveName('x86_64-pc-windows-msvc')).toBe('google-workspace-cli-x86_64-pc-windows-msvc.zip');
    expect(gwsArchiveName('aarch64-apple-darwin')).toBe('google-workspace-cli-aarch64-apple-darwin.tar.gz');
  });

  it('pins a SHA-256 for every target of the pinned version', () => {
    expect(GWS_VERSION).toBe('0.22.5');
    expect(Object.keys(GWS_RELEASES)).toHaveLength(7);
    for (const hash of Object.values(GWS_RELEASES)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('finding gws', () => {
  function program(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, '');
    chmodSync(file, 0o755);
    return file;
  }

  it("prefers a gws on the owner's PATH, then the one Mercury installed", () => {
    const own = join(work, 'gws-bin');
    const ownGws = program(own, 'gws');
    const onPath = program(join(work, 'path-bin'), 'gws');
    expect(findGws({ platform: 'linux', env: { PATH: join(work, 'path-bin') }, mercuryDir: own })).toEqual({ path: onPath, source: 'path' });
    expect(findGws({ platform: 'linux', env: { PATH: join(work, 'elsewhere') }, mercuryDir: own })).toEqual({ path: ownGws, source: 'mercury' });
    expect(findGws({ platform: 'linux', env: {}, mercuryDir: join(work, 'none') })).toBeNull();
  });

  it("reads Windows' Path key", () => {
    const onPath = program(join(work, 'npm'), 'gws.cmd');
    expect(findGws({ platform: 'win32', env: { Path: join(work, 'npm') }, mercuryDir: join(work, 'none') })?.path).toBe(onPath);
  });
});

describe("Mercury's gws on run_command's PATH", () => {
  it('changes nothing until Mercury has installed gws', () => {
    expect(withMercuryGwsOnPath({ PATH: '/usr/bin' }, join(work, 'gws-bin'))).toBeUndefined();
  });

  it("adds the folder last, so the owner's own gws wins, keeping the existing key", () => {
    const dir = join(work, 'gws-bin');
    mkdirSync(dir);
    const windows = withMercuryGwsOnPath({ Path: 'C:\\Windows', HOME: 'x' }, dir);
    expect(Object.keys(windows ?? {}).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(windows?.Path?.startsWith('C:\\Windows')).toBe(true);
    expect(windows?.Path?.endsWith(dir)).toBe(true);
    expect(withMercuryGwsOnPath({}, dir)).toEqual({ PATH: dir });
  });

  it('lets a shell command run the gws Mercury installed', async () => {
    const previous = process.env.MERCURY_HOME;
    process.env.MERCURY_HOME = work;
    try {
      const dir = join(work, 'gws-bin');
      mkdirSync(dir);
      if (process.platform === 'win32') writeFileSync(join(dir, 'gws.cmd'), '@echo fake-gws-ok\r\n');
      else {
        writeFileSync(join(dir, 'gws'), '#!/bin/sh\necho fake-gws-ok\n');
        chmodSync(join(dir, 'gws'), 0o755);
      }
      const result = await executeCommand('gws', work, 20_000);
      expect(result.stdout).toContain('fake-gws-ok');
    } finally {
      if (previous === undefined) delete process.env.MERCURY_HOME;
      else process.env.MERCURY_HOME = previous;
    }
  });
});

describe('installing gws', () => {
  const linux = 'x86_64-unknown-linux-gnu';
  const windows = 'x86_64-pc-windows-msvc';

  it('downloads, checks and installs a tar.gz release', async () => {
    const data = archive(gwsArchiveName(linux), 'gws', 'fake gws binary');
    const { fetchImpl, requested } = serve(data);
    const dir = join(work, 'gws-bin');
    const result = await installGws({ target: linux, dir, baseUrl: 'https://example.test/v0.22.5', checksums: { [linux]: sha256(data) }, fetchImpl });
    expect(requested).toEqual([`https://example.test/v0.22.5/${gwsArchiveName(linux)}`]);
    expect(result).toEqual({ path: join(dir, 'gws'), version: GWS_VERSION });
    expect(readFileSync(join(dir, 'gws'), 'utf8')).toBe('fake gws binary');
    expect(readFileSync(join(dir, 'version.txt'), 'utf8').trim()).toBe(GWS_VERSION);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'gws')).mode & 0o111).not.toBe(0);
  });

  it.skipIf(!BSDTAR)('installs the Windows zip release', async () => {
    const data = archive(gwsArchiveName(windows), 'gws.exe', 'fake gws.exe');
    const dir = join(work, 'gws-bin');
    await installGws({ target: windows, dir, checksums: { [windows]: sha256(data) }, fetchImpl: serve(data).fetchImpl });
    expect(readFileSync(join(dir, 'gws.exe'), 'utf8')).toBe('fake gws.exe');
  });

  it('refuses a download that does not match its checksum and installs nothing', async () => {
    const data = archive(gwsArchiveName(linux), 'gws', 'tampered');
    const dir = join(work, 'gws-bin');
    await expect(installGws({ target: linux, dir, checksums: { [linux]: 'a'.repeat(64) }, fetchImpl: serve(data).fetchImpl }))
      .rejects.toThrow(/doesn't match its checksum/);
    expect(existsSync(join(dir, 'gws'))).toBe(false);
  });

  it('reports a failed download', async () => {
    await expect(installGws({ target: linux, dir: join(work, 'gws-bin'), checksums: { [linux]: 'a'.repeat(64) }, fetchImpl: serve(Buffer.alloc(0), 404).fetchImpl }))
      .rejects.toThrow(/HTTP 404/);
  });

  it('refuses an archive without the program and installs nothing', async () => {
    const data = archive(gwsArchiveName(linux), 'README.md', 'not a program');
    const dir = join(work, 'gws-bin');
    await expect(installGws({ target: linux, dir, checksums: { [linux]: sha256(data) }, fetchImpl: serve(data).fetchImpl }))
      .rejects.toThrow(/has no gws/);
    expect(existsSync(join(dir, 'gws'))).toBe(false);
  });

  it('says so when gws has no release for this computer', async () => {
    await expect(installGws({ target: null, dir: join(work, 'gws-bin') })).rejects.toThrow(/has no release/);
  });
});
