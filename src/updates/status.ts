import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchLatestVersion } from '../cli/latest-version.js';
import { fetchLatestFromRegistry } from '../cli/update-notice.js';
import { detectInstall, NPM_PACKAGE, type InstallInfo } from './install-kind.js';
import { compareVersions, getManifest, latestFor, messagesFor, readManifestCache, requiredFor, MANIFEST_TTL_MS, type ManifestCache, type ManifestMessage, type MinimumVersion } from './manifest.js';
import { blockedFor, justUpdated, markJustUpdatedSeen, readJob, updatesHome, type UpdateJob } from './server-updater.js';

/**
 * What GET /api/updates says (UPDATES.md §2): this server's version,
 * the newest one, whether it must update, and how an update is going.
 */

export interface LatestRelease {
  version: string;
  date?: string;
  notes?: string;
  notesUrl?: string;
  /** False when the last try found the release isn't published yet. */
  downloadable?: boolean;
}

export interface ServerUpdateStatus {
  current: string;
  channel: 'stable' | 'dev';
  install: InstallInfo['kind'];
  canSelfUpdate: boolean;
  cannotReason?: string;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  required: { version: string; severity: MinimumVersion['severity']; reason: string } | null;
  manifestVerified: boolean;
  checkedAt: number | null;
  job: UpdateJob | null;
  blocked: { version: string; failures: number; lastError: string } | null;
  justUpdated: { from: string; to: string; at: number } | null;
  messages: ManifestMessage[];
}

const RELEASES = 'https://github.com/cosmicstack-labs/mercury-agent/releases';

// The plain look-up when there's no signed manifest: GitHub (binary, dev) or npm.
interface Fallback { version: string | null; checkedAt: number }
const fallbackPath = () => join(updatesHome(), 'fallback.json');

function readFallback(): Fallback | null {
  try { return existsSync(fallbackPath()) ? JSON.parse(readFileSync(fallbackPath(), 'utf-8')) as Fallback : null; } catch { return null; }
}

async function fallbackLatest(install: InstallInfo, force: boolean, now: number): Promise<Fallback> {
  const cached = readFallback();
  if (cached && !force && now - cached.checkedAt < MANIFEST_TTL_MS) return cached;
  const version = install.kind === 'npm' && install.channel === 'stable'
    ? await fetchLatestFromRegistry(NPM_PACKAGE)
    : await fetchLatestVersion(install.channel);
  const next = { version: version ?? cached?.version ?? null, checkedAt: now };
  try { mkdirSync(updatesHome(), { recursive: true }); writeFileSync(fallbackPath(), JSON.stringify(next)); } catch { /* best effort */ }
  return next;
}

let refreshing: Promise<unknown> | null = null;

export interface StatusOptions {
  current: string;
  /** "Check for updates": refetch now (the manifest rate-limits itself). */
  force?: boolean;
  /** The client showed "what's new": stop reporting justUpdated. */
  seen?: boolean;
  install?: InstallInfo;
  now?: number;
}

export async function serverUpdateStatus(opts: StatusOptions): Promise<ServerUpdateStatus> {
  const now = opts.now ?? Date.now();
  const install = opts.install ?? detectInstall(opts.current);

  // A stale cache answers now and refreshes behind; only a first-ever check waits.
  let cache: ManifestCache = readManifestCache();
  const stale = cache.checkedAt === null || now - cache.checkedAt >= MANIFEST_TTL_MS;
  if (opts.force || cache.checkedAt === null) {
    cache = await getManifest({ force: opts.force });
  } else if (stale && !refreshing) {
    refreshing = getManifest().finally(() => { refreshing = null; });
  }

  const manifest = cache.manifest;
  let latest: LatestRelease | null = latestFor(manifest, 'server', install.channel);
  let checkedAt = cache.checkedAt;
  if (!latest) {
    const fb = await fallbackLatest(install, !!opts.force, now);
    checkedAt = fb.checkedAt;
    if (fb.version) latest = { version: fb.version, notesUrl: install.channel === 'dev' ? `${RELEASES}/tag/mercury-dev-latest` : `${RELEASES}/tag/v${fb.version}` };
  }

  const job = readJob();
  if (latest && job?.notAvailable && job.to === latest.version && now - job.updatedAt < 60 * 60_000) latest = { ...latest, downloadable: false };

  const updateAvailable = !!latest && compareVersions(latest.version, opts.current) > 0;
  const req = requiredFor(manifest, 'server', opts.current);
  const just = justUpdated(opts.current);
  if (just && opts.seen) markJustUpdatedSeen();

  return {
    current: opts.current,
    channel: install.channel,
    install: install.kind,
    canSelfUpdate: install.canSelfUpdate,
    ...(install.cannotReason ? { cannotReason: install.cannotReason } : {}),
    latest,
    updateAvailable,
    required: req ? { version: req.version, severity: req.severity, reason: req.reason } : null,
    manifestVerified: !!manifest,
    checkedAt,
    job,
    blocked: updateAvailable ? blockedFor(latest?.version) : null,
    justUpdated: just,
    messages: messagesFor(manifest, 'server', opts.current, now),
  };
}

/** The version an update should go to: the newest known one, if newer. */
export function targetVersion(status: ServerUpdateStatus): string | null {
  return status.updateAvailable && status.latest ? status.latest.version : null;
}
