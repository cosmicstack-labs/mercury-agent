/**
 * Mercury Desktop downloads, read from src/data/desktop-release.json.
 * The release pipeline rewrites that file from the real release assets, so
 * anything here must cope with an asset that isn't there (no link) and a
 * size of 0 (no size shown).
 */
import data from '@site/src/data/desktop-release.json';

export type AssetKey =
  | 'macos-arm64'
  | 'macos-x64'
  | 'windows-x64-setup'
  | 'windows-x64-msi'
  | 'linux-appimage'
  | 'linux-deb'
  | 'linux-rpm';

export interface Asset { url: string; name: string; size: number }

interface Release {
  version: string;
  date: string;
  notesUrl: string;
  assets: Partial<Record<AssetKey, Asset>>;
}

export const DESKTOP: Release = data as Release;

export const GITHUB_RELEASES = 'https://github.com/cosmicstack-labs/mercury-agent/releases';

/** The asset, or null when this release doesn't have it. */
export function asset(key: AssetKey): Asset | null {
  const a = DESKTOP.assets[key];
  return a && a.url ? a : null;
}

/** "118 MB", or '' when the size isn't known. */
export function sizeOf(a: Asset | null): string {
  if (!a || !a.size) return '';
  const mb = a.size / 1024 / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** What each download is, in words. */
export const LABEL: Record<AssetKey, { os: string; what: string; detail: string }> = {
  'macos-arm64': { os: 'macOS', what: 'Apple Silicon', detail: 'M1 and newer, .dmg' },
  'macos-x64': { os: 'macOS', what: 'Intel', detail: 'Intel Macs, .dmg' },
  'windows-x64-setup': { os: 'Windows', what: 'Installer', detail: 'Windows 10 and 11, x64, .exe' },
  'windows-x64-msi': { os: 'Windows', what: 'MSI package', detail: 'For managed installs, x64, .msi' },
  'linux-appimage': { os: 'Linux', what: 'AppImage', detail: 'Any distribution, x64' },
  'linux-deb': { os: 'Linux', what: 'Debian / Ubuntu', detail: 'x64, .deb' },
  'linux-rpm': { os: 'Linux', what: 'Fedora / openSUSE', detail: 'x64, .rpm' },
};

/** "3 November 2026" from "2026-11-03". */
export function releaseDate(): string {
  const d = new Date(`${DESKTOP.date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return DESKTOP.date;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* ── the server (CLI) downloads of the same release ── */

export type ServerKey =
  | 'macos-arm64' | 'macos-x64'
  | 'linux-x64' | 'linux-x64-baseline' | 'linux-arm64'
  | 'windows-x64' | 'windows-x64-baseline'
  | 'web' | 'checksums';

interface ServerRelease { npm: string; assets: Partial<Record<ServerKey, Asset>> }

export const SERVER: ServerRelease = ((data as { server?: ServerRelease }).server) ?? { npm: '@cosmicstack/mercury-agent', assets: {} };

export function serverAsset(key: ServerKey): Asset | null {
  const a = SERVER.assets[key];
  return a && a.url ? a : null;
}

export const SERVER_LABEL: Record<ServerKey, { os: string; what: string }> = {
  'macos-arm64': { os: 'macOS', what: 'Apple Silicon' },
  'macos-x64': { os: 'macOS', what: 'Intel' },
  'linux-x64': { os: 'Linux', what: 'x64' },
  'linux-x64-baseline': { os: 'Linux', what: 'x64, older CPUs (no AVX2)' },
  'linux-arm64': { os: 'Linux', what: 'ARM64 (Raspberry Pi 4/5, Graviton)' },
  'windows-x64': { os: 'Windows', what: 'x64' },
  'windows-x64-baseline': { os: 'Windows', what: 'x64, older CPUs (no AVX2)' },
  web: { os: 'All', what: 'Web dashboard assets (web.tar.gz)' },
  checksums: { os: 'All', what: 'SHA-256 checksums (checksums.txt)' },
};
