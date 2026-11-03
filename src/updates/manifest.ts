import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { verifyMinisign } from './minisign.js';
import { UPDATE_PUBLIC_KEY } from './public-key.js';

/**
 * The update manifest (UPDATES.md §1): one signed file that says what
 * the newest Mercury and Mercury Desktop are, which versions must update,
 * and what to tell people.
 *
 * Trust rules: a manifest whose signature doesn't verify is ignored (the
 * plain version look-ups take over, and nothing is ever "required" on their
 * word); one older than the newest we've seen is ignored (no replaying an
 * old file); no manifest at all never blocks anything (fail open).
 */

export const MANIFEST_URLS = [
  'https://mercuryagent.sh/updates/manifest.json',
  'https://raw.githubusercontent.com/cosmicstack-labs/mercury-agent/main/website/static/updates/manifest.json',
];

/** Refetch at most this often on our own. */
export const MANIFEST_TTL_MS = 6 * 60 * 60_000;
/** "Check for updates" bypasses the cache, at most this often. */
export const FORCED_CHECK_GAP_MS = 60_000;

export type UpdateApp = 'server' | 'desktop';

export interface ReleaseInfo {
  version: string;
  date?: string;
  notes?: string;
  notesUrl?: string;
}

export interface MinimumVersion {
  version: string;
  severity: 'security' | 'required';
  reason: string;
  since?: string;
}

export interface ManifestMessage {
  id: string;
  title: string;
  body?: string;
  level: 'info' | 'warning' | 'critical';
  apps?: UpdateApp[];
  versions?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  link?: { label: string; url: string } | null;
  dismissible?: boolean;
}

export interface AppSection {
  channels?: { stable?: ReleaseInfo | null; dev?: ReleaseInfo | null };
  minimum?: MinimumVersion | null;
}

export interface UpdateManifest {
  schema: 1;
  issuedAt: string;
  server?: AppSection;
  desktop?: AppSection;
  messages?: ManifestMessage[];
}

// ─── Versions ────────────────────────────────────────────────────────────────

function parts(v: string): number[] {
  return v.trim().replace(/^v/, '').split(/[.\-+]/).map((p) => parseInt(p, 10) || 0);
}

/**
 * -1 / 0 / 1. Numeric part by part, the same way the CLI's update notice has
 * always compared: a dev build of 1.4.2 (`1.4.2-dev.20261103.abc`) counts as
 * newer than 1.4.2 itself, which is when dev builds are made.
 */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Does `version` satisfy every comparator in `range` ("<1.5.0", ">=1.4 <1.5", "=1.4.2")? Empty matches all. */
export function versionMatches(version: string, range?: string | null): boolean {
  const comparators = String(range ?? '').trim().split(/\s+/).filter(Boolean);
  for (const c of comparators) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d[\w.\-+]*)$/.exec(c);
    if (!m) return false; // a range we can't read applies to nobody
    const cmp = compareVersions(version, m[2]);
    const op = m[1] ?? '=';
    const ok = op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

// ─── Reading the file ────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function release(v: unknown): ReleaseInfo | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r.version)) return null;
  return {
    version: r.version.trim().replace(/^v/, ''),
    ...(isStr(r.date) ? { date: r.date } : {}),
    ...(isStr(r.notes) ? { notes: r.notes } : {}),
    ...(isStr(r.notesUrl) && /^https:\/\//.test(r.notesUrl) ? { notesUrl: r.notesUrl } : {}),
  };
}

function minimum(v: unknown): MinimumVersion | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!isStr(m.version)) return null;
  return {
    version: m.version.trim().replace(/^v/, ''),
    severity: m.severity === 'security' ? 'security' : 'required',
    reason: isStr(m.reason) ? m.reason : 'This version must be updated.',
    ...(isStr(m.since) ? { since: m.since } : {}),
  };
}

function section(v: unknown): AppSection {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ch = (s.channels && typeof s.channels === 'object' ? s.channels : {}) as Record<string, unknown>;
  return { channels: { stable: release(ch.stable), dev: release(ch.dev) }, minimum: minimum(s.minimum) };
}

function message(v: unknown): ManifestMessage | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!isStr(m.id) || !isStr(m.title)) return null;
  const level = m.level === 'critical' || m.level === 'warning' ? m.level : 'info';
  const apps = Array.isArray(m.apps) ? m.apps.filter((a): a is UpdateApp => a === 'server' || a === 'desktop') : undefined;
  const link = m.link && typeof m.link === 'object' && isStr((m.link as Record<string, unknown>).url) && /^https:\/\//.test(String((m.link as Record<string, unknown>).url))
    ? { label: isStr((m.link as Record<string, unknown>).label) ? String((m.link as Record<string, unknown>).label) : 'Read more', url: String((m.link as Record<string, unknown>).url) }
    : null;
  return {
    id: m.id, title: m.title, level,
    ...(isStr(m.body) ? { body: m.body } : {}),
    ...(apps ? { apps } : {}),
    versions: isStr(m.versions) ? m.versions : null,
    startsAt: isStr(m.startsAt) ? m.startsAt : null,
    endsAt: isStr(m.endsAt) ? m.endsAt : null,
    link,
    // Only a critical message may refuse to be dismissed.
    dismissible: level === 'critical' ? m.dismissible !== false : true,
  };
}

/** The manifest from its text, normalised; null when it isn't one. */
export function parseManifest(text: string): UpdateManifest | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || !isStr(r.issuedAt) || Number.isNaN(Date.parse(r.issuedAt))) return null;
  return {
    schema: 1,
    issuedAt: r.issuedAt,
    server: section(r.server),
    desktop: section(r.desktop),
    messages: Array.isArray(r.messages) ? r.messages.map(message).filter((m): m is ManifestMessage => !!m) : [],
  };
}

/** The manifest when `signature` (Tauri `.sig` text) verifies against `publicKey`; otherwise why not. */
export function verifyManifest(text: string, signature: string, publicKey = UPDATE_PUBLIC_KEY): { manifest: UpdateManifest } | { error: string } {
  const check = verifyMinisign(Buffer.from(text, 'utf8'), signature, publicKey);
  if (!check.ok) return { error: check.reason ?? 'The signature did not verify.' };
  const manifest = parseManifest(text);
  return manifest ? { manifest } : { error: 'The signed file is not an update manifest.' };
}

// ─── What applies to whom ────────────────────────────────────────────────────

export function latestFor(manifest: UpdateManifest | null, app: UpdateApp, channel: 'stable' | 'dev'): ReleaseInfo | null {
  return manifest?.[app]?.channels?.[channel] ?? null;
}

/** The required update when `version` is below the minimum; null otherwise. */
export function requiredFor(manifest: UpdateManifest | null, app: UpdateApp, version: string): MinimumVersion | null {
  const min = manifest?.[app]?.minimum;
  return min && compareVersions(version, min.version) < 0 ? min : null;
}

/** Messages for this app and version that are live now. */
export function messagesFor(manifest: UpdateManifest | null, app: UpdateApp, version: string, now = Date.now()): ManifestMessage[] {
  return (manifest?.messages ?? []).filter((m) => {
    if (m.apps && m.apps.length && !m.apps.includes(app)) return false;
    if (m.startsAt && Date.parse(m.startsAt) > now) return false;
    if (m.endsAt && Date.parse(m.endsAt) <= now) return false;
    return versionMatches(version, m.versions);
  });
}

// ─── Fetching and the cache ──────────────────────────────────────────────────

export interface ManifestCache {
  manifest: UpdateManifest | null;
  /** The newest issuedAt ever accepted (anti-replay). */
  highestIssuedAt?: string;
  checkedAt: number | null;
  forcedAt?: number;
  /** Why the last fetch didn't give a usable manifest. */
  error?: string;
}

function updatesDir(): string {
  return join(getMercuryHome(), 'updates');
}

function cachePath(): string {
  return join(updatesDir(), 'manifest.json');
}

export function readManifestCache(): ManifestCache {
  try {
    if (existsSync(cachePath())) {
      const c = JSON.parse(readFileSync(cachePath(), 'utf-8')) as ManifestCache;
      return { manifest: c.manifest ?? null, highestIssuedAt: c.highestIssuedAt, checkedAt: c.checkedAt ?? null, forcedAt: c.forcedAt, error: c.error };
    }
  } catch { /* corrupt → start clean */ }
  return { manifest: null, checkedAt: null };
}

function writeManifestCache(c: ManifestCache): void {
  try {
    mkdirSync(updatesDir(), { recursive: true });
    const tmp = `${cachePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf-8');
    renameSync(tmp, cachePath());
  } catch (err) {
    logger.debug({ err }, 'updates: saving the manifest cache failed');
  }
}

async function fetchText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' } as RequestInit);
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 512 * 1024 ? null : text;
  } catch {
    return null;
  }
}

export interface FetchManifestOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  urls?: string[];
  publicKey?: string;
  now?: number;
  timeoutMs?: number;
}

/**
 * The manifest to act on: the cached one while it's fresh, otherwise a new
 * verified one (primary address, then the mirror). Never throws; a failure
 * keeps the last good manifest.
 */
export async function getManifest(opts: FetchManifestOptions = {}): Promise<ManifestCache> {
  const now = opts.now ?? Date.now();
  const cache = readManifestCache();
  const fresh = cache.checkedAt !== null && now - cache.checkedAt < MANIFEST_TTL_MS;
  if (!opts.force && fresh) return cache;
  if (opts.force && cache.forcedAt && now - cache.forcedAt < FORCED_CHECK_GAP_MS) return cache;

  const fetchImpl = opts.fetchImpl ?? fetch;
  let error = 'The update information could not be reached.';
  let accepted: UpdateManifest | null = null;
  for (const url of opts.urls ?? MANIFEST_URLS) {
    const [text, sig] = await Promise.all([fetchText(url, fetchImpl, opts.timeoutMs ?? 8000), fetchText(`${url}.sig`, fetchImpl, opts.timeoutMs ?? 8000)]);
    if (!text || !sig) continue;
    const v = verifyManifest(text, sig, opts.publicKey);
    if ('error' in v) { error = `The update information was not signed by Mercury (${v.error})`; continue; }
    if (cache.highestIssuedAt && Date.parse(v.manifest.issuedAt) < Date.parse(cache.highestIssuedAt)) {
      error = 'The update information was older than one already seen; ignored.';
      continue;
    }
    accepted = v.manifest;
    break;
  }

  const next: ManifestCache = accepted
    ? { manifest: accepted, highestIssuedAt: accepted.issuedAt, checkedAt: now, forcedAt: opts.force ? now : cache.forcedAt }
    : { ...cache, checkedAt: now, forcedAt: opts.force ? now : cache.forcedAt, error };
  if (!accepted) logger.debug({ error }, 'updates: no new manifest');
  writeManifestCache(next);
  return next;
}
