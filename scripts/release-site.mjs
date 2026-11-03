#!/usr/bin/env node
/**
 * Point the website at a published release (run by .github/workflows/release.yml
 * after the GitHub release is public; can be run by hand the same way):
 *
 *   node scripts/release-site.mjs 1.5.0 [--no-desktop] [--feeds-only] [--notes RELEASE.md]
 *
 *  1. reads the release's assets from GitHub;
 *  2. desktop: checks latest.json (every platform has a url and a signature —
 *     the updater rejects the whole file otherwise) and writes it to
 *     website/static/desktop/latest.json, the updater endpoint; writes the
 *     download page's website/src/data/desktop-release.json;
 *  3. records the release in the signed update manifest (server, and desktop
 *     unless --no-desktop) and re-signs it.
 *
 * --feeds-only (patch releases): only what installed apps read, the update
 * manifest and desktop/latest.json; the download page and hero keep pointing
 * at the release they show (a fresh install then updates itself).
 *
 * It changes files only; the website goes live when docs/ is rebuilt and pushed.
 * GITHUB_TOKEN is used when set (higher API limits); the release must be public.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'cosmicstack-labs/mercury-agent';
const args = process.argv.slice(2);
const version = args[0];
const withDesktop = !args.includes('--no-desktop');
const feedsOnly = args.includes('--feeds-only');
const notesAt = args.indexOf('--notes');
const notesFile = notesAt > 0 ? args[notesAt + 1] : join(ROOT, 'RELEASE.md');

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) die('Usage: node scripts/release-site.mjs <version> [--no-desktop] [--notes file.md]');

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'mercury-release' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, { headers });
if (!res.ok) die(`Release v${version}: GitHub answered ${res.status}. Is it published?`);
const release = await res.json();
if (release.draft) die(`Release v${version} is still a draft.`);
const assets = release.assets ?? [];
const byName = new Map(assets.map((a) => [a.name, a]));

// The server's own assets must be there: installers and `mercury upgrade` fetch them.
for (const need of ['checksums.txt', 'web.tar.gz', 'mercury-macos-arm64', 'mercury-linux-x64', 'mercury-win-x64.exe']) {
  if (!byName.has(need)) die(`Release v${version} has no ${need}.`);
}

const run = (file, argv) => execFileSync(process.execPath, [join(ROOT, 'scripts', file), ...argv], { stdio: 'inherit', cwd: ROOT });

if (withDesktop) {
  const latestAsset = byName.get('latest.json');
  if (!latestAsset) die(`Release v${version} has no latest.json (the desktop build didn't finish?).`);
  const latest = await (await fetch(latestAsset.browser_download_url)).json();
  if (String(latest.version).replace(/^v/, '') !== version) die(`latest.json says ${latest.version}, not ${version}.`);
  const platforms = Object.entries(latest.platforms ?? {});
  if (!platforms.length) die('latest.json lists no platforms.');
  for (const [name, p] of platforms) if (!p?.url || !p?.signature) die(`latest.json: ${name} has no url or signature.`);
  latest.notes = release.body || latest.notes || '';
  const out = join(ROOT, 'website/static/desktop/latest.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`✓ website/static/desktop/latest.json: ${platforms.map(([n]) => n).join(', ')}`);

  if (!feedsOnly) {
  // The download page: one file per platform, found by the names tauri-action gives them.
  const find = (re) => {
    const a = assets.find((x) => re.test(x.name));
    return a ? { url: a.browser_download_url, name: a.name, size: a.size } : undefined;
  };
  const downloads = {
    version,
    date: (release.published_at ?? new Date().toISOString()).slice(0, 10),
    notesUrl: release.html_url,
    assets: Object.fromEntries(Object.entries({
      'macos-arm64': find(/_aarch64\.dmg$/),
      'macos-x64': find(/_x64\.dmg$/),
      'windows-x64-setup': find(/_x64-setup\.exe$/),
      'windows-x64-msi': find(/_x64_[^_]+\.msi$/),
      'linux-appimage': find(/_amd64\.AppImage$/),
      'linux-deb': find(/_amd64\.deb$/),
      'linux-rpm': find(/\.x86_64\.rpm$/),
    }).filter(([, v]) => v)),
  };
  // The server's downloads too, for the docs' release page.
  const server = (name) => { const a = byName.get(name); return a ? { url: a.browser_download_url, name: a.name, size: a.size } : undefined; };
  downloads.server = {
    npm: `@cosmicstack/mercury-agent@${version}`,
    assets: Object.fromEntries(Object.entries({
      'macos-arm64': server('mercury-macos-arm64'),
      'macos-x64': server('mercury-macos-x64'),
      'linux-x64': server('mercury-linux-x64'),
      'linux-x64-baseline': server('mercury-linux-x64-baseline'),
      'linux-arm64': server('mercury-linux-arm64'),
      'windows-x64': server('mercury-win-x64.exe'),
      'windows-x64-baseline': server('mercury-win-x64-baseline.exe'),
      'web': server('web.tar.gz'),
      'checksums': server('checksums.txt'),
    }).filter(([, v]) => v)),
  };
  const missing = ['macos-arm64', 'macos-x64', 'windows-x64-setup', 'linux-appimage'].filter((k) => !downloads.assets[k]);
  if (missing.length) die(`Release v${version} is missing desktop downloads: ${missing.join(', ')}.`);
  const dl = join(ROOT, 'website/src/data/desktop-release.json');
  mkdirSync(dirname(dl), { recursive: true });
  writeFileSync(dl, `${JSON.stringify(downloads, null, 2)}\n`);
  console.log(`✓ website/src/data/desktop-release.json: ${Object.keys(downloads.assets).join(', ')}`);
  }
}

run('update-manifest.mjs', ['release', 'server', version, '--notes', notesFile, '--url', release.html_url]);
if (withDesktop) run('update-manifest.mjs', ['release', 'desktop', version, '--notes', notesFile, '--url', release.html_url]);
run('update-manifest.mjs', ['verify']);
console.log(`Website files point at v${version}. Rebuild docs/ (cd website && npm run build:prod) and push to deploy.`);
