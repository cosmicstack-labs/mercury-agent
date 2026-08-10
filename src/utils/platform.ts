import { existsSync } from 'node:fs';
import { posix as posixPath } from 'node:path';

export function isTermux(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux') return false;
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
