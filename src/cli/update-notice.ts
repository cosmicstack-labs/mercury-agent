import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Version-aware, GRACEFUL notices for Mercury Code:
 *
 *  1. One-time `/whatsnew` hint — shown only when the running version differs
 *     from the last one this machine booted (first install OR an update).
 *     Persisted, so it can never repeat for the same version.
 *  2. Background update check — throttled to once per CHECK_INTERVAL_MS,
 *     entirely async (never blocks boot), and quiet about versions the user
 *     ignored via `/update ignore`.
 *
 * Anti-annoyance rules baked in: every notice fires at most once per version
 * (persisted markers, not memory), nothing repeats within a boot, and the
 * user can silence update banners for a given version permanently.
 */

interface UpdateState {
  /** The version last booted on this machine — the "first time" marker. */
  lastLaunchVersion?: string;
  /** The latest version the user chose to ignore (`/update ignore`). */
  ignoredUpdate?: string;
  /** Last background check (ms epoch) — throttles npm lookups. */
  checkedAt?: number;
  /** Latest version observed by the last successful check. */
  latestSeen?: string;
}

const STATE_PATH = () => join(getMercuryHome(), 'update-state.json');
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // at most one npm look-up per 12h

export function loadUpdateState(): UpdateState {
  try {
    if (existsSync(STATE_PATH())) return JSON.parse(readFileSync(STATE_PATH(), 'utf-8')) as UpdateState;
  } catch { /* corrupt state → start clean */ }
  return {};
}

export function saveUpdateState(state: UpdateState): void {
  try {
    if (!existsSync(getMercuryHome())) return; // home torn down → nothing to persist
    writeFileSync(STATE_PATH(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'update-notice: failed to persist state');
  }
}

/** Numeric semver comparison: returns true when `a` is strictly newer than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.\-]/).map((p) => parseInt(p, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Should the one-time "/whatsnew" hint show for this boot? True when this is
 * the first launch ever (no marker) or the version CHANGED (fresh install or
 * an update). False for every subsequent boot of the same version.
 */
export function shouldShowWhatsNewHint(currentVersion: string): boolean {
  const state = loadUpdateState();
  if (state.lastLaunchVersion === currentVersion) return false;
  return state.lastLaunchVersion === undefined || isNewerVersion(currentVersion, state.lastLaunchVersion);
}

/** Persist that this version's hint has been shown — the anti-nag guarantee. */
export function markWhatsNewHintShown(currentVersion: string): void {
  const state = loadUpdateState();
  state.lastLaunchVersion = currentVersion;
  saveUpdateState(state);
}

/** The version the user ignored (`/update ignore`), if any. */
export function getIgnoredUpdateVersion(): string | undefined {
  return loadUpdateState().ignoredUpdate;
}

/** Permanently silence update notices for this specific newer version. */
export function ignoreUpdateVersion(latestVersion: string): void {
  const state = loadUpdateState();
  state.ignoredUpdate = latestVersion;
  saveUpdateState(state);
}

/**
 * Latest published version straight from the npm registry over HTTPS —
 * the preferred route: no npm binary needed, and no `npm.cmd` shell issue
 * on Windows (`execFile('npm')` without a shell fails there with EINVAL,
 * which the old code silently swallowed, so Windows never saw updates).
 */
export async function fetchLatestFromRegistry(
  packageName: string,
  timeoutMs = 8_000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: unknown };
    return typeof data?.version === 'string' && data.version.trim() ? data.version.trim() : null;
  } catch (err) {
    logger.debug({ err }, 'update-notice: registry lookup failed');
    return null;
  }
}

/** Async `npm view` with a hard timeout — fallback when the registry is unreachable. */
function fetchLatestViaNpm(packageName: string, timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['view', packageName, 'version'],
      // npm is `npm.cmd` on Windows: it needs a shell to spawn.
      { timeout: timeoutMs, encoding: 'utf-8', shell: process.platform === 'win32' },
      (err, stdout) => {
        resolve(err ? null : String(stdout).trim() || null);
      },
    );
  });
}

async function fetchLatestNpmVersion(packageName: string, timeoutMs = 8_000): Promise<string | null> {
  return (await fetchLatestFromRegistry(packageName, timeoutMs)) ?? fetchLatestViaNpm(packageName, timeoutMs);
}

/**
 * Background update check. Throttled (one remote look-up per CHECK_INTERVAL_MS
 * across ALL boots), fully async, silent on failure. Returns the latest
 * version when an update exists AND the user has not ignored it.
 */
export async function maybeCheckForUpdate(
  currentVersion: string,
  packageName = '@cosmicstack/mercury-agent',
): Promise<string | null> {
  const state = loadUpdateState();
  const throttled = state.checkedAt !== undefined && Date.now() - state.checkedAt < CHECK_INTERVAL_MS;

  let latest = throttled ? state.latestSeen : undefined;
  if (!throttled) {
    latest = (await fetchLatestNpmVersion(packageName)) ?? state.latestSeen;
    saveUpdateState({ ...state, checkedAt: Date.now(), latestSeen: latest ?? state.latestSeen });
  }

  if (!latest || !isNewerVersion(latest, currentVersion)) return null;
  if (state.ignoredUpdate === latest) return null; // user chose to ignore this version
  return latest;
}

/** Latest version the check last saw (for `/update ignore` even when throttled). */
export function latestSeenUpdate(currentVersion: string): string | null {
  const state = loadUpdateState();
  if (state.latestSeen && isNewerVersion(state.latestSeen, currentVersion)) return state.latestSeen;
  return null;
}