import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { getMercuryHome } from '../utils/config.js';
import { resolveFromDirs } from '../capabilities/shell/argv-lane.js';

const execFileAsync = promisify(execFile);

export const GWS_VERSION = '0.22.5';

const RELEASE_BASE = `https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}`;

export const GWS_RELEASES: Readonly<Record<string, string>> = Object.freeze({
  'aarch64-apple-darwin': '1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac',
  'x86_64-apple-darwin': '51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2',
  'x86_64-pc-windows-msvc': '407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2',
  'x86_64-unknown-linux-gnu': 'de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f',
  'x86_64-unknown-linux-musl': '4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920',
  'aarch64-unknown-linux-gnu': '94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0',
  'aarch64-unknown-linux-musl': 'e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a',
});

export type Libc = 'gnu' | 'musl';

export interface FoundGws {
  path: string;
  source: 'path' | 'mercury';
}

export interface InstallGwsOptions {
  target?: string | null;
  dir?: string;
  baseUrl?: string;
  checksums?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

export function mercuryGwsDir(): string {
  return join(getMercuryHome(), 'gws-bin');
}

export function gwsBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'gws.exe' : 'gws';
}

export function detectLibc(): Libc {
  try {
    const result = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 5_000 });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('musl') ? 'musl' : 'gnu';
  } catch {
    return 'gnu';
  }
}

export function gwsTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch, libc: Libc = 'gnu'): string | null {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  if (!cpu) return null;
  const os = platform === 'darwin' ? 'apple-darwin' : platform === 'win32' ? 'pc-windows-msvc' : platform === 'linux' ? `unknown-linux-${libc}` : null;
  if (!os) return null;
  const target = `${cpu}-${os}`;
  return GWS_RELEASES[target] ? target : null;
}

export function gwsArchiveName(target: string): string {
  return `google-workspace-cli-${target}.${target.includes('windows') ? 'zip' : 'tar.gz'}`;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

export function findGws(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; mercuryDir?: string } = {}): FoundGws | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const dirs = (env[pathKey(env)] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const onPath = resolveFromDirs('gws', dirs, platform);
  if (onPath) return { path: onPath, source: 'path' };
  const own = join(opts.mercuryDir ?? mercuryGwsDir(), gwsBinaryName(platform));
  return existsSync(own) ? { path: own, source: 'mercury' } : null;
}

export function withMercuryGwsOnPath(env: NodeJS.ProcessEnv = process.env, dir: string = mercuryGwsDir()): NodeJS.ProcessEnv | undefined {
  if (!existsSync(dir)) return undefined;
  const key = pathKey(env);
  const current = env[key];
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

function systemTar(): string {
  if (process.platform !== 'win32') return 'tar';
  const bundled = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(bundled) ? bundled : 'tar';
}

export async function installGws(opts: InstallGwsOptions = {}): Promise<{ path: string; version: string }> {
  const target = opts.target === undefined
    ? gwsTarget(process.platform, process.arch, process.platform === 'linux' ? detectLibc() : 'gnu')
    : opts.target;
  if (!target) {
    throw new Error(`gws has no release for ${process.platform} ${process.arch}. See https://github.com/googleworkspace/cli/releases`);
  }
  const expected = (opts.checksums ?? GWS_RELEASES)[target];
  if (!expected) throw new Error(`Mercury has no checksum for the gws release ${target}.`);

  const archiveName = gwsArchiveName(target);
  const dir = opts.dir ?? mercuryGwsDir();
  const binary = gwsBinaryName(target.includes('windows') ? 'win32' : 'linux');
  const work = mkdtempSync(join(tmpdir(), 'mercury-gws-'));
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? RELEASE_BASE}/${archiveName}`, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Downloading gws failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) {
      throw new Error(`The gws download doesn't match its checksum (expected ${expected}, got ${actual}). Nothing was installed.`);
    }

    writeFileSync(join(work, archiveName), data);
    mkdirSync(join(work, 'unpacked'));
    try {
      await execFileAsync(systemTar(), [archiveName.endsWith('.zip') ? '-xf' : '-xzf', archiveName, '-C', 'unpacked'], { cwd: work, timeout: 120_000, windowsHide: true });
    } catch (err) {
      throw new Error(`Couldn't unpack gws: ${(err as Error).message.split('\n')[0]}`);
    }
    const unpacked = join(work, 'unpacked', binary);
    if (!existsSync(unpacked)) throw new Error(`The gws archive has no ${binary}. Nothing was installed.`);

    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, binary);
    const staging = `${finalPath}.new`;
    copyFileSync(unpacked, staging);
    if (!binary.endsWith('.exe')) chmodSync(staging, 0o755);
    renameSync(staging, finalPath);
    writeFileSync(join(dir, 'version.txt'), `${GWS_VERSION}\n`);
    return { path: finalPath, version: GWS_VERSION };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
