#!/usr/bin/env node
/**
 * After publishing a Mercury Desktop release on GitHub (desktop-v<version>),
 * point the apps at it:
 *
 *   node scripts/promote-desktop-release.mjs 0.2.0 [--notes notes.md]
 *
 *  1. downloads latest.json from the release and checks every platform entry
 *     has a url and a signature (the updater rejects the whole file otherwise);
 *  2. writes it to website/static/desktop/latest.json (the updater endpoint);
 *  3. records the release in the update manifest and re-signs it.
 *
 * Nothing goes live until the website deploys. A draft release has no public
 * latest.json, so this fails until the release is published.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'cosmicstack-labs/mercury-agent';
const version = process.argv[2];
const notesAt = process.argv.indexOf('--notes');
const notes = notesAt > 0 ? process.argv[notesAt + 1] : undefined;

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/promote-desktop-release.mjs <version> [--notes file.md]');
  process.exit(1);
}

const url = `https://github.com/${REPO}/releases/download/desktop-v${version}/latest.json`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`✗ ${url} → ${res.status}. Publish the draft release first.`);
  process.exit(1);
}
const latest = await res.json();
if (latest.version?.replace(/^v/, '') !== version) {
  console.error(`✗ latest.json says ${latest.version}, not ${version}.`);
  process.exit(1);
}
const platforms = Object.entries(latest.platforms ?? {});
if (!platforms.length) { console.error('✗ latest.json lists no platforms.'); process.exit(1); }
for (const [name, p] of platforms) {
  if (!p?.url || !p?.signature) { console.error(`✗ ${name} has no url or signature.`); process.exit(1); }
}

// The release body is the notes people read before and after updating.
let body = latest.notes ?? '';
if (!notes) {
  try {
    const rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/desktop-v${version}`, { headers: { Accept: 'application/vnd.github+json' } })).json();
    if (rel?.body) body = rel.body;
  } catch { /* keep latest.json's */ }
}
latest.notes = body;

const out = join(ROOT, 'website/static/desktop/latest.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`✓ ${out.replace(`${ROOT}/`, '')}: ${platforms.map(([n]) => n).join(', ')}`);

const notesFile = notes ?? join(ROOT, '.desktop-notes.tmp.md');
if (!notes) writeFileSync(notesFile, body);
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/update-manifest.mjs'), 'release', 'desktop', version, '--notes', notesFile], { stdio: 'inherit' });
} finally {
  if (!notes) try { (await import('node:fs')).unlinkSync(notesFile); } catch { /* gone */ }
}
console.log('Commit website/static/desktop/latest.json and website/static/updates/, then deploy the website.');
