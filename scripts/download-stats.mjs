#!/usr/bin/env node
/**
 * Total downloads across every distribution path, for the README badge:
 *   - npm:      all-time downloads of @cosmicstack/mercury-agent
 *   - binaries: GitHub release executables (what install.sh / install.ps1
 *               and `mercury upgrade` fetch). Only the executables are
 *               counted: every install also fetches checksums.txt and
 *               web.tar.gz, which would triple-count one install.
 *   - desktop:  Mercury Desktop packages on the same releases (.dmg,
 *               -setup.exe, .msi, .AppImage, .deb, .rpm, and the .app.tar.gz
 *               that install-desktop.sh fetches). Signatures and latest.json
 *               are skipped.
 *
 * All three add up to one total. Writes a shields.io endpoint document
 * (.github/badges/downloads.json, read by the badge through
 * raw.githubusercontent.com) plus a breakdown file.
 * Usage: node scripts/download-stats.mjs [--dry-run]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PKG = '@cosmicstack/mercury-agent';
const REPO = 'cosmicstack-labs/mercury-agent';
// .github/badges, not docs/: the website deploy replaces docs/ wholesale.
const OUT = '.github/badges/downloads.json';
const BREAKDOWN = '.github/badges/downloads-breakdown.json';
const dryRun = process.argv.includes('--dry-run');

const headers = { 'User-Agent': 'mercury-download-stats', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** npm's range API caps each query at 18 months: walk forward from the first publish. */
async function npmTotal() {
  const meta = await json(`https://registry.npmjs.org/${PKG.replace('/', '%2F')}`);
  let start = new Date(meta.time.created);
  const today = new Date();
  let total = 0;
  while (start <= today) {
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 540);
    const to = end > today ? today : end;
    const d = (x) => x.toISOString().slice(0, 10);
    const r = await json(`https://api.npmjs.org/downloads/range/${d(start)}:${d(to)}/${PKG}`);
    total += (r.downloads ?? []).reduce((a, x) => a + x.downloads, 0);
    start = new Date(to); start.setUTCDate(start.getUTCDate() + 1);
  }
  return total;
}

const isExecutable = (name) => /^mercury(-dev)?-(macos|linux|win)-/.test(name);

/** The desktop package's platform, or null when the asset isn't a desktop download. */
function desktopPlatform(name) {
  if (!name.startsWith('Mercury') || name.endsWith('.sig')) return null;
  if (/\.dmg$|\.app\.tar\.gz$/.test(name)) return 'macos';
  if (/-setup\.exe$|\.msi$/.test(name)) return 'windows';
  if (/\.AppImage$|\.deb$|\.rpm$/.test(name)) return 'linux';
  return null;
}

async function releaseTotals() {
  const out = { binaries: 0, desktop: { macos: 0, windows: 0, linux: 0 } };
  for (let page = 1; ; page++) {
    const releases = await json(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (releases.length === 0) break;
    for (const r of releases) for (const a of r.assets ?? []) {
      if (isExecutable(a.name)) out.binaries += a.download_count;
      const platform = desktopPlatform(a.name);
      if (platform) out.desktop[platform] += a.download_count;
    }
  }
  return out;
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

const [npm, releases] = await Promise.all([npmTotal(), releaseTotals()]);
const { binaries } = releases;
const desktop = Object.values(releases.desktop).reduce((a, n) => a + n, 0);
const total = npm + binaries + desktop;
const badge = { schemaVersion: 1, label: 'downloads', message: short(total), color: '0ea5e9', cacheSeconds: 21600 };
const breakdown = { total, npm, binaries, desktop, desktopByPlatform: releases.desktop, updatedAt: new Date().toISOString() };
console.log(JSON.stringify(breakdown));
if (!dryRun) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(badge) + '\n');
  writeFileSync(BREAKDOWN, JSON.stringify(breakdown, null, 2) + '\n');
}
