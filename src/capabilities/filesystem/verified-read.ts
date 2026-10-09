import { openSync, fstatSync, closeSync, constants, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { FileIdentity, FsAccessResult } from '../permissions.js';

export type VerifiedOpen = { fd: number; stat: Stats; error?: undefined } | { fd?: undefined; stat?: undefined; error: string };

/**
 * Open the canonical path a read was authorised for and prove the descriptor
 * is the same file: `fstat` dev/ino must equal the identity captured by the
 * permission check. A symlink or rename swapped in between the check and the
 * open is refused instead of silently read (TOCTOU). The final component is
 * opened with O_NOFOLLOW where the platform has it, so a symlink planted at
 * the canonical path fails outright.
 *
 * The caller owns the returned descriptor and must `closeSync` it.
 */
export function openVerified(canonical: string, expected?: FileIdentity): VerifiedOpen {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(canonical, flags);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { error: `Error: File not found: ${canonical}` };
    if (err?.code === 'ELOOP') return { error: `Error: ${canonical} changed between the permission check and the read (a symlink replaced it). Retry.` };
    return { error: `Error reading file: ${err?.message ?? String(err)}` };
  }
  let stat: Stats;
  try {
    stat = fstatSync(fd);
  } catch (err: any) {
    closeSync(fd);
    return { error: `Error reading file: ${err?.message ?? String(err)}` };
  }
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    closeSync(fd);
    return { error: `Error: ${canonical} changed between the permission check and the read (expected inode ${expected.ino}, found ${stat.ino}). Retry.` };
  }
  return { fd, stat };
}

/**
 * The denial text every read tool returns, so the model learns one lesson:
 * call `approve_scope` on the directory that actually needs approving. For a
 * symlink that escapes the scopes that is the target's directory, not the
 * link's; a hard-link refusal cannot be fixed by a scope at all, so the
 * reason is passed through.
 */
export function readDenialMessage(resolved: string, check: FsAccessResult): string {
  if (check.code === 'hardlink') {
    return `Error: ${check.reason ?? `Permission denied for read access to ${resolved}`}`;
  }
  if (check.code === 'symlink-escape' && check.canonical) {
    return `Error: Permission denied for read access to ${resolved} (it resolves to ${check.canonical}). Use the approve_scope tool with path="${dirname(check.canonical)}" and mode="read" to request access from the user.`;
  }
  return `Error: Permission denied for read access to ${resolved}. Use the approve_scope tool with path="${dirname(resolved)}" and mode="read" to request access from the user.`;
}
