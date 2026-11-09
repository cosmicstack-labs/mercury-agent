import { isAbsolute, resolve } from 'node:path';

/**
 * Where a tool's relative paths resolve. A plain `() => cwd` works; a
 * registry can also attach named roots so that, e.g., a bot's
 * "_shared/report.md" always means the fleet-shared folder, whatever
 * directory the bot is in. Without that, a bot whose cwd was a code
 * checkout wrote its "_shared/…" files into the repo.
 */
export type CwdSource = (() => string) & {
  roots?: () => ReadonlyArray<readonly [prefix: string, dir: string]>;
};

export function resolveToolPath(path: string, getCwd: CwdSource): string {
  if (isAbsolute(path)) return resolve(path);
  const normalized = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  for (const [prefix, dir] of getCwd.roots?.() ?? []) {
    if (normalized === prefix) return resolve(dir);
    if (normalized.startsWith(`${prefix}/`)) return resolve(dir, normalized.slice(prefix.length + 1));
  }
  return resolve(getCwd(), path);
}
