import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

/** Open a folder in the OS file manager (Finder / Explorer / xdg-open). Resolves false when that is not possible (headless, Termux). */
export async function openFolder(dir: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? ['open', [dir]]
    : process.platform === 'win32' ? ['explorer', [dir]]
      : ['xdg-open', [dir]];
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd[0] as string, cmd[1] as string[], { timeout: 5000 }, (err) => resolve(!err));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** ~/Documents/… instead of /Users/x/Documents/… — what a person expects to read. */
export function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
