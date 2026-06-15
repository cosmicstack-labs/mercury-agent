import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';

const SIGNAL_CLI_VERSION = '0.14.5';
const MERCURY_HOME = () => process.env.MERCURY_HOME || path.join(homedir(), '.mercury');
const SIGNAL_CLI_DIR = () => path.join(MERCURY_HOME(), 'signal-cli');

const NATIVE_PLATFORMS: Record<string, string> = {
  'linux-arm64': `signal-cli-${SIGNAL_CLI_VERSION}-Linux-native-arm64.tar.gz`,
  'linux-x64': `signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz`,
};

function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function isNativeAvailable(): boolean {
  return getPlatformKey() in NATIVE_PLATFORMS;
}

function getNativeArchiveName(): string | null {
  return NATIVE_PLATFORMS[getPlatformKey()] ?? null;
}

function getDownloadUrl(archiveName: string): string {
  return `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/${archiveName}`;
}

function getBinaryPath(): string {
  const dir = SIGNAL_CLI_DIR();
  if (process.platform === 'win32') {
    return path.join(dir, 'bin', 'signal-cli.exe');
  }
  return path.join(dir, 'bin', 'signal-cli');
}

function getJarPath(): string {
  return path.join(SIGNAL_CLI_DIR(), 'lib', `signal-cli-${SIGNAL_CLI_VERSION}.jar`);
}

export function findSignalCli(): string | null {
  const binaryPath = getBinaryPath();
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  const jarPath = getJarPath();
  if (existsSync(jarPath)) {
    return jarPath;
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const systemPath = execSync(`${whichCmd} signal-cli 2>/dev/null`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (systemPath) return systemPath;
  } catch { /* not on PATH */ }

  return null;
}

export function isNativeBinary(binaryPath: string): boolean {
  return !binaryPath.endsWith('.jar') && !binaryPath.endsWith('.sh');
}

export function isJarBinary(binaryPath: string): boolean {
  return binaryPath.endsWith('.jar');
}

export function isWrapperScript(binaryPath: string): boolean {
  return binaryPath.endsWith('/bin/signal-cli') || binaryPath.endsWith('\\bin\\signal-cli.bat');
}

export function getSignalCliCommand(binaryPath: string): string[] {
  if (isWrapperScript(binaryPath)) {
    return [binaryPath];
  }
  if (isJarBinary(binaryPath)) {
    const javaPath = findJavaPath() || 'java';
    return [javaPath, '-jar', binaryPath];
  }
  return [binaryPath];
}

export function getSignalCliEnv(): Record<string, string> {
  const javaPath = findJavaPath();
  if (!javaPath) return {};

  const javaDir = path.dirname(javaPath);
  const javaHome = path.dirname(javaDir);
  return { JAVA_HOME: javaHome };
}

export function buildSignalCliArgs(
  binaryPath: string,
  phoneNumber: string,
  command: string,
  extraArgs: string[] = [],
  configDir?: string,
): string[] {
  const cmd = getSignalCliCommand(binaryPath);
  const args: string[] = [...cmd.slice(1)];
  if (configDir) {
    args.push('--config', configDir);
  }
  args.push('-u', phoneNumber, command, ...extraArgs);
  return args;
}

export function getSignalCliExecEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...getSignalCliEnv() };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderProgressBar(downloaded: number, total: number | null): string {
  const BAR_WIDTH = 20;
  if (total && total > 0) {
    const pct = Math.min(downloaded / total, 1);
    const filled = Math.round(pct * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
    return `${bar} ${formatBytes(downloaded)} / ${formatBytes(total)} (${Math.round(pct * 100)}%)`;
  }
  return `${formatBytes(downloaded)}`;
}

async function downloadWithProgress(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download signal-cli: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Download response had no body');
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : null;

  const nodeStream = Readable.fromWeb(response.body as any);
  const fileStream = createWriteStream(destPath);

  let downloaded = 0;
  let lastUpdate = 0;

  nodeStream.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastUpdate >= 100) {
      lastUpdate = now;
      process.stdout.write(`\r  ${renderProgressBar(downloaded, total)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(fileStream);
    fileStream.on('finish', () => {
      process.stdout.write(`\r  ${renderProgressBar(downloaded, total)}\n`);
      resolve();
    });
    fileStream.on('error', reject);
    nodeStream.on('error', reject);
  });
}

async function downloadAndExtract(url: string, archivePath: string, dir: string): Promise<void> {
  logger.info({ url }, 'Downloading signal-cli...');

  const tmpArchive = archivePath + '.tmp';
  try {
    await downloadWithProgress(url, tmpArchive);

    process.stdout.write('  Extracting signal-cli...\r');
    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    mkdirSync(path.join(dir, 'lib'), { recursive: true });

    execSync(`tar -xzf "${tmpArchive}" -C "${dir}" --strip-components=1`, { stdio: 'pipe' });
    process.stdout.write('  Extracting signal-cli... done\n');
  } catch (err: any) {
    logger.error({ err: err?.message }, 'Failed to extract signal-cli archive');
    throw new Error(`Failed to extract signal-cli: ${err?.message || err}`);
  } finally {
    try { fs.unlinkSync(tmpArchive); } catch { /* ignore */ }
  }
}

export async function downloadSignalCli(preferNative: boolean = true): Promise<string> {
  const dir = SIGNAL_CLI_DIR();
  const expectedBinary = getBinaryPath();
  const expectedJar = getJarPath();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(expectedBinary)) {
    logger.info({ path: expectedBinary }, 'Signal CLI native binary already exists');
    return expectedBinary;
  }
  if (existsSync(expectedJar)) {
    logger.info({ path: expectedJar }, 'Signal CLI JAR already exists');
    return expectedJar;
  }

  const useNative = preferNative && isNativeAvailable();

  if (useNative) {
    logger.info({ platform: getPlatformKey() }, 'Native binary available — no Java required');
    const archiveName = getNativeArchiveName()!;
    const url = getDownloadUrl(archiveName);
    const archivePath = path.join(dir, archiveName);

    try {
      await downloadAndExtract(url, archivePath, dir);

      const binaryPath = getBinaryPath();
      if (!existsSync(binaryPath)) {
        throw new Error(`Native binary not found after extraction at ${binaryPath}`);
      }
      try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }
      logger.info({ path: binaryPath }, 'Signal CLI native binary installed');
      return binaryPath;
    } catch (nativeErr: any) {
      logger.warn({ err: nativeErr?.message }, 'Native binary download failed, falling back to JAR mode');
      // Clean up partial extraction so JAR extraction can start fresh
      try { rmSync(path.join(dir, 'bin'), { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(path.join(dir, 'lib'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // JAR mode (fallback or non-native platform)
  if (!checkJavaAvailable()) {
    throw new Error(
      'Signal CLI requires Java (JRE 17+) on this platform.\n' +
      'No native binary is available for macOS/Windows, and Java was not found.\n' +
      'Install Java: https://adoptium.net/ or `brew install openjdk`\n' +
      'Then run: mercury doctor'
    );
  }

  logger.info('Using JAR mode — Java runtime found');
  const jarArchiveName = `signal-cli-${SIGNAL_CLI_VERSION}.tar.gz`;
  const url = getDownloadUrl(jarArchiveName);
  const archivePath = path.join(dir, jarArchiveName);

  await downloadAndExtract(url, archivePath, dir);

  const jarPath = getJarPath();
  if (!existsSync(jarPath)) {
    throw new Error(`JAR not found after extraction at ${jarPath}`);
  }

  // Prefer the wrapper script which handles classpath and JAVA_HOME
  const binaryPath = getBinaryPath();
  if (existsSync(binaryPath)) {
    try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }
    logger.info({ path: binaryPath }, 'Signal CLI installed (wrapper script + JAR)');
    return binaryPath;
  }

  logger.info({ path: jarPath }, 'Signal CLI JAR installed');
  return jarPath;
}

export async function ensureSignalCli(): Promise<string> {
  const existing = findSignalCli();
  if (existing) {
    logger.info({ path: existing }, 'Signal CLI found');
    return existing;
  }

  logger.info('Signal CLI not found, downloading...');
  return downloadSignalCli(true);
}

export function removeSignalCli(): boolean {
  const dir = SIGNAL_CLI_DIR();
  if (!existsSync(dir)) return false;

  try {
    rmSync(dir, { recursive: true, force: true });
    logger.info({ dir }, 'Signal CLI directory removed');
    return true;
  } catch (err: any) {
    logger.error({ err: err?.message }, 'Failed to remove Signal CLI directory');
    return false;
  }
}

const HOMEBREW_JAVA_PATHS = [
  '/opt/homebrew/opt/openjdk/bin/java',
  '/usr/local/opt/openjdk/bin/java',
];

let cachedJavaPath: string | null | undefined;

function verifyJavaWorks(javaPath: string): boolean {
  try {
    execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function findJavaPath(): string | null {
  if (cachedJavaPath !== undefined) return cachedJavaPath;

  // Check Homebrew paths first — they're known-good installations
  for (const candidate of HOMEBREW_JAVA_PATHS) {
    if (existsSync(candidate) && verifyJavaWorks(candidate)) {
      cachedJavaPath = candidate;
      return candidate;
    }
  }

  // Then check system PATH — but skip macOS stubs like /usr/bin/java
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const systemPath = execSync(`${whichCmd} java 2>/dev/null`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (systemPath && verifyJavaWorks(systemPath)) {
      cachedJavaPath = systemPath;
      return systemPath;
    }
  } catch { /* not on PATH or doesn't work */ }

  cachedJavaPath = null;
  return null;
}

export function checkJavaAvailable(): boolean {
  return findJavaPath() !== null;
}

export function getSignalCliVersion(binaryPath: string): string | null {
  const cmd = getSignalCliCommand(binaryPath);
  const env = getSignalCliExecEnv();
  try {
    const output = execSync(`${cmd.join(' ')} --version`, { encoding: 'utf-8', timeout: 10000, env });
    return output.trim();
  } catch {
    return null;
  }
}

export function getSignalCliDir(): string {
  return SIGNAL_CLI_DIR();
}