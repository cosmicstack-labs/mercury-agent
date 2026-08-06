/**
 * Crash flag — survival mechanism for ungraceful exits.
 *
 * When Mercury crashes or is killed mid-task, we write a small JSON file
 * to ~/.mercury/.crash-flag so the next startup can report what happened
 * to the user.  The flag is deleted after being read.
 *
 * This solves the "silent task death" problem: users who return to
 * Mercury after a crash see "I crashed while working on X" instead of
 * a blank slate they have to investigate.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

export interface CrashFlag {
  reason: string;
  timestamp: number;
  activeTask?: string;
  channelId?: string;
  channelType?: string;
}

const CRASH_FLAG_FILE = '.crash-flag';

function crashFlagPath(): string {
  return join(getMercuryHome(), CRASH_FLAG_FILE);
}

export function writeCrashFlag(flag: CrashFlag): void {
  try {
    writeFileSync(crashFlagPath(), JSON.stringify(flag, null, 2), 'utf-8');
  } catch {
    // Best-effort — if the FS is broken we're already in trouble.
  }
}

export function readCrashFlag(): CrashFlag | null {
  const p = crashFlagPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as CrashFlag;
  } catch {
    return null;
  }
}

export function clearCrashFlag(): void {
  try { unlinkSync(crashFlagPath()); } catch { /* already gone */ }
}