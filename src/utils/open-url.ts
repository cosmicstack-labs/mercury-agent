import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTermux } from './platform.js';

const execFileAsync = promisify(execFile);

export interface UrlOpener {
  command: string;
  args: string[];
}

export function getUrlOpeners(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): UrlOpener[] {
  if (isTermux(env, platform)) {
    return [
      { command: 'termux-open-url', args: [url] },
      { command: 'xdg-open', args: [url] },
    ];
  }
  if (platform === 'darwin') return [{ command: 'open', args: [url] }];
  if (platform === 'win32') return [{ command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }];
  return [{ command: 'xdg-open', args: [url] }];
}

export async function openUrl(
  url: string,
  run: (command: string, args: string[]) => Promise<unknown> = (command, args) =>
    execFileAsync(command, args, { windowsHide: true, timeout: 10_000 }),
  openers: UrlOpener[] = getUrlOpeners(url),
): Promise<boolean> {
  for (const opener of openers) {
    try {
      await run(opener.command, opener.args);
      return true;
    } catch {
      // Try the next platform-safe opener, or let the caller show the URL.
    }
  }
  return false;
}
