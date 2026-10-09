import { existsSync } from 'node:fs';
import { posix as posixPath } from 'node:path';

/**
 * Platforms on which a Termux environment can exist. Node built by the
 * Termux package repo (`pkg install nodejs`) reports `process.platform ===
 * 'android'`, NOT `'linux'` — gating on `'linux'` alone made every real
 * Termux device look like a desktop and sent `installService()` down the
 * "Unsupported platform: android" path. Keep both: some Termux setups (and
 * proot/glibc Node builds) still report `'linux'`.
 */
export function isTermuxEligiblePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'android';
}

export function isTermux(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isTermuxEligiblePlatform(platform)) return false;
  return Boolean(
    env.TERMUX_VERSION ||
    env.TERMUX_APP_PID ||
    env.PREFIX?.includes('com.termux'),
  );
}

export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidates = [env.MERCURY_SHELL, env.SHELL];
  if (isTermux(env, platform)) {
    candidates.push(env.PREFIX ? posixPath.join(env.PREFIX, 'bin', 'sh') : undefined);
  }
  candidates.push('/bin/sh');

  return candidates.find((candidate) => candidate && fileExists(candidate)) || '/bin/sh';
}
