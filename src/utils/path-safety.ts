import { resolve, relative, sep } from 'node:path';

/**
 * Returns true when `candidate` resolves to `root` or a path strictly inside it.
 * Uses path.relative instead of string prefix checks to avoid prefix bypass
 * (e.g. /workspace vs /workspace-private).
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const rel = relative(resolvedRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}
