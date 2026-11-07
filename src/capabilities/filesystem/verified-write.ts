import { openSync, fstatSync, closeSync, lstatSync, realpathSync, constants, type Stats } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { FsAccessResult } from '../permissions.js';

/** Open before truncating, and verify the target captured before approval. */
export function openVerifiedWrite(check: FsAccessResult, fallback: string, read = false):
  { fd: number; stat: Stats; error?: undefined } | { error: string; fd?: undefined; stat?: undefined } {
  const path = check.canonical ?? fallback;
  let fd: number | undefined;
  try {
    // Never O_TRUNC: an identity mismatch must leave the replacement intact.
    fd = openSync(path, (read ? constants.O_RDWR : constants.O_WRONLY) | (constants.O_NOFOLLOW ?? 0)
      | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!check.fileId || stat.dev !== check.fileId.dev || stat.ino !== check.fileId.ino
      || (check.fileNlink !== undefined && stat.nlink !== check.fileNlink)) {
      closeSync(fd);
      return { error: `Error: ${fallback} changed between the permission check and the write. Retry.` };
    }
    if (!stat.isFile()) {
      closeSync(fd);
      return { error: `Error: ${fallback} is not a regular file.` };
    }
    return { fd, stat };
  } catch (err: unknown) {
    if (fd !== undefined) closeSync(fd);
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { error: `Error: File not found: ${fallback}. Use create_file to create new files.` };
    return { error: `Error opening file for write: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Capture an existing canonical ancestor before an approval can yield. */
export function captureWriteAncestor(path: string): FsAccessResult['writeAncestor'] {
  let current = dirname(path);
  for (let i = 0; i < 256; i++) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || realpathSync(current) !== current) return undefined;
      return { path: current, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Refuse parent replacements made while approval was pending. This is not
 * an atomic openat-style guarantee against a hostile concurrent OS process. */
export function verifyCreateParent(check: FsAccessResult, fallback: string): string | undefined {
  const target = check.canonical ?? fallback;
  const ancestor = check.writeAncestor;
  if (!ancestor) return `Error: Cannot verify the approved parent of ${fallback}. Retry.`;
  try {
    const stat = lstatSync(ancestor.path);
    if (!stat.isDirectory() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino
      || realpathSync(ancestor.path) !== ancestor.path) throw new Error('changed');
    // New intermediate directories may have appeared during approval. Resolve
    // every now-existing component, without creating anything, before mkdir.
    let current = dirname(target);
    const tail: string[] = [];
    for (let i = 0; i < 256; i++) {
      try {
        const canonical = join(realpathSync(current), ...tail.reverse());
        if (canonical !== dirname(target)) throw new Error('changed');
        return undefined;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const parent = dirname(current);
      if (parent === current) break;
      tail.push(basename(current));
      current = parent;
    }
  } catch { /* return one actionable refusal below */ }
  return `Error: ${fallback} parent changed between the permission check and creation. Retry.`;
}
