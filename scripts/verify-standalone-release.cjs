#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.resolve(process.argv[2] || path.join(root, 'release', `v${pkg.version}`));
const assets = [
  'mercury-macos-arm64',
  'mercury-macos-x64',
  'mercury-linux-x64',
  'mercury-linux-arm64',
  'mercury-win-x64.exe',
  'web.tar.gz',
];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(releaseDir)) fail(`release directory not found: ${releaseDir}`);

const allowedEntries = new Set([...assets, 'checksums.txt']);
for (const entry of fs.readdirSync(releaseDir)) {
  if (!allowedEntries.has(entry)) fail(`unexpected release entry: ${entry}`);
}

const checksumPath = path.join(releaseDir, 'checksums.txt');
if (!fs.existsSync(checksumPath)) fail('checksums.txt is missing');

const checksums = new Map();
for (const line of fs.readFileSync(checksumPath, 'utf8').trim().split(/\r?\n/)) {
  const match = line.match(/^([a-fA-F0-9]{64})  ([^/\\]+)$/);
  if (!match) fail(`invalid checksum line: ${line}`);
  if (checksums.has(match[2])) fail(`duplicate checksum entry: ${match[2]}`);
  checksums.set(match[2], match[1].toLowerCase());
}

if (checksums.size !== assets.length || assets.some((asset) => !checksums.has(asset))) {
  fail(`checksums.txt must contain exactly: ${assets.join(', ')}`);
}

for (const asset of assets) {
  const filePath = path.join(releaseDir, asset);
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) fail(`${asset} is missing`);
  const actual = sha256(filePath);
  if (actual !== checksums.get(asset)) fail(`checksum mismatch for ${asset}`);
}

const archiveEntries = execFileSync('tar', ['-tzf', path.join(releaseDir, 'web.tar.gz')], {
  encoding: 'utf8',
}).trim().split(/\r?\n/);
if (!archiveEntries.some((entry) => entry === 'web' || entry === 'web/')) fail('web.tar.gz has no web/ root');
for (const entry of archiveEntries) {
  if (!/^web(?:\/|$)/.test(entry) || /(?:^|\/)\.\.(?:\/|$)/.test(entry)) {
    fail(`unsafe archive entry: ${entry}`);
  }
  if (/(?:^|\/)\.DS_Store$/.test(entry) || /\.map$/.test(entry)) {
    fail(`junk file present in web.tar.gz: ${entry}`);
  }
}

console.log(`  ✓ verified ${assets.length} standalone release assets`);
