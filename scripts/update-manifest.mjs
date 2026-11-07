#!/usr/bin/env node
/**
 * Edit and sign the update manifest (UPDATES.md):
 * website/static/updates/manifest.json + manifest.json.sig.
 *
 *   node scripts/update-manifest.mjs show
 *   node scripts/update-manifest.mjs release server 1.5.0 --notes RELEASE.md [--channel dev] [--url …]
 *   node scripts/update-manifest.mjs release desktop 0.2.0 --notes notes.md
 *   node scripts/update-manifest.mjs require server 1.4.2 --reason "Fixes …" [--severity security|required]
 *   node scripts/update-manifest.mjs require server none
 *   node scripts/update-manifest.mjs message add --id 2026-11-launch --title "…" --body notes.md
 *        [--level info|warning|critical] [--apps desktop,server] [--versions "<1.5.0"]
 *        [--ends 2026-12-01] [--link-label "Read more" --link-url https://…] [--sticky]
 *   node scripts/update-manifest.mjs message remove 2026-11-launch
 *   node scripts/update-manifest.mjs sign        (re-sign without changes)
 *   node scripts/update-manifest.mjs verify
 *
 * Every change re-signs. The key is the desktop updater key:
 * TAURI_SIGNING_PRIVATE_KEY_PATH (default ~/.tauri/mercury-updates.key) and
 * TAURI_SIGNING_PRIVATE_KEY_PASSWORD (default: the .password file beside it).
 * Nothing is published: the files change in the repo and go live when the
 * website deploys.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'website/static/updates/manifest.json');
const SIG = `${FILE}.sig`;
const TAURI = join(ROOT, 'apps/desktop/node_modules/.bin/tauri');
const REPO = 'cosmicstack-labs/mercury-agent';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

function parseArgs(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, opts };
}

function load() {
  if (!existsSync(FILE)) {
    return { schema: 1, issuedAt: null, server: { channels: { stable: null, dev: null }, minimum: null }, desktop: { channels: { stable: null }, minimum: null }, messages: [] };
  }
  return JSON.parse(readFileSync(FILE, 'utf-8'));
}

/** A file's text, or the value itself when it isn't a file. */
const textOf = (v) => (typeof v === 'string' && existsSync(v) ? readFileSync(v, 'utf-8').trim() : typeof v === 'string' ? v : '');

const app = (name) => (name === 'server' || name === 'desktop' ? name : die(`Say server or desktop, not "${name}".`));
const version = (v) => (VERSION_RE.test(String(v)) ? String(v) : die(`"${v}" is not a version like 1.5.0.`));
const isoDay = (v) => (v ? (Number.isNaN(Date.parse(v)) ? die(`"${v}" is not a date.`) : new Date(v).toISOString()) : null);

/**
 * The signing key: TAURI_SIGNING_PRIVATE_KEY (the key text, as in CI) or the
 * key file (TAURI_SIGNING_PRIVATE_KEY_PATH, default ~/.tauri/mercury-updates.key,
 * with its password from TAURI_SIGNING_PRIVATE_KEY_PASSWORD or the .password
 * file beside it). The password travels in the environment, never argv.
 */
function signingEnv() {
  const env = { ...process.env };
  if (env.TAURI_SIGNING_PRIVATE_KEY) return env;
  const key = env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), '.tauri/mercury-updates.key');
  if (!existsSync(key)) die(`No signing key: set TAURI_SIGNING_PRIVATE_KEY, or put the key at ${key}.`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(key, 'utf-8').trim();
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined && existsSync(`${key}.password`)) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(`${key}.password`, 'utf-8').trim();
  }
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return env;
}

function sign() {
  if (!existsSync(TAURI)) die('Install the desktop dependencies first (cd apps/desktop && npm ci): signing uses the Tauri CLI.');
  if (existsSync(SIG)) unlinkSync(SIG);
  execFileSync(TAURI, ['signer', 'sign', FILE], { stdio: ['ignore', 'ignore', 'inherit'], env: signingEnv() });
  if (!existsSync(SIG)) die('Signing wrote no signature.');
  console.log(`✓ Signed ${FILE.replace(`${ROOT}/`, '')}`);
}

function save(m) {
  m.issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(m, null, 2)}\n`);
  sign();
}

/**
 * Check the committed signature with the public key every install has
 * (tauri.conf.json's updater pubkey): Ed25519 over BLAKE2b-512 of the file
 * (minisign "ED"), plus the global signature over the trusted comment.
 * The same check as src/updates/minisign.ts, without needing a build.
 */
function verify() {
  const conf = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf-8'));
  const b64text = (v) => Buffer.from(v.trim(), 'base64').toString('utf8');
  const lines = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pkRaw = Buffer.from(lines(b64text(conf.plugins.updater.pubkey)).find((l) => !/^untrusted comment:/i.test(l)), 'base64');
  const sigLines = lines(b64text(readFileSync(SIG, 'utf-8')));
  const sigRaw = Buffer.from(sigLines[1], 'base64');
  const trusted = sigLines[2].replace(/^trusted comment:\s?/i, '');
  const globalSig = Buffer.from(sigLines[3], 'base64');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pkRaw.subarray(10, 42).toString('base64url') }, format: 'jwk' });
  const alg = sigRaw.subarray(0, 2).toString('latin1');
  const data = readFileSync(FILE);
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const ok = sigRaw.subarray(2, 10).equals(pkRaw.subarray(2, 10))
    && cryptoVerify(null, message, key, sigRaw.subarray(10, 74))
    && cryptoVerify(null, Buffer.concat([sigRaw.subarray(10, 74), Buffer.from(trusted, 'utf8')]), key, globalSig);
  if (!ok) die('The signature does not match the manifest.');
  console.log('✓ Signature verifies with the public key clients have.');
}

function show(m) {
  const line = (label, ch) => ch ? `${label} ${ch.version}${ch.date ? ` (${ch.date})` : ''}` : `${label} —`;
  console.log(`Issued ${m.issuedAt ?? 'never'}`);
  for (const a of ['server', 'desktop']) {
    const chans = Object.entries(m[a].channels).map(([k, v]) => line(k, v)).join(' · ');
    const min = m[a].minimum ? `required ≥ ${m[a].minimum.version} (${m[a].minimum.severity}): ${m[a].minimum.reason}` : 'nothing required';
    console.log(`${a.padEnd(8)} ${chans} · ${min}`);
  }
  for (const msg of m.messages) console.log(`message  ${msg.id} [${msg.level}] ${msg.title} → ${msg.apps.join(',')}${msg.versions ? ` ${msg.versions}` : ''}`);
}

const { pos, opts } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = pos;
const m = load();

switch (cmd) {
  case 'show': show(m); break;
  case 'sign': sign(); break;
  case 'verify': verify(); break;
  case 'release': {
    const a = app(rest[0]); const v = version(rest[1]);
    const channel = opts.channel || 'stable';
    if (a === 'desktop' && channel !== 'stable') die('Mercury Desktop has only the stable channel.');
    const tag = a === 'server' ? `v${v}` : `desktop-v${v}`;
    m[a].channels[channel] = {
      version: v,
      date: (opts.date ? isoDay(opts.date) : new Date().toISOString()).slice(0, 10),
      // A release-notes file's own title ("# Release v1.5.0") repeats what the app already shows.
      notes: textOf(opts.notes).replace(/^# .*\n+/, ''),
      notesUrl: opts.url || `https://github.com/${REPO}/releases/tag/${tag}`,
    };
    if (m[a].minimum && !(compare(m[a].minimum.version, v) <= 0)) die(`The required version (${m[a].minimum.version}) is newer than this release.`);
    save(m); show(m); break;
  }
  case 'require': {
    const a = app(rest[0]);
    if (rest[1] === 'none') { m[a].minimum = null; save(m); show(m); break; }
    const v = version(rest[1]);
    const latest = m[a].channels.stable?.version;
    if (!latest || compare(v, latest) > 0) die(`Release ${v} first: a required version must be one people can install.`);
    if (!opts.reason || opts.reason === true) die('Say why (--reason): people read it on the force-update screen.');
    const severity = opts.severity || 'required';
    if (!['security', 'required'].includes(severity)) die('--severity is security or required.');
    m[a].minimum = { version: v, severity, reason: String(opts.reason), since: new Date().toISOString().slice(0, 10) };
    save(m); show(m); break;
  }
  case 'message': {
    const sub = rest[0];
    if (sub === 'remove') {
      const before = m.messages.length;
      m.messages = m.messages.filter((x) => x.id !== rest[1]);
      if (m.messages.length === before) die(`No message "${rest[1]}".`);
      save(m); show(m); break;
    }
    if (sub !== 'add') die('message add | message remove <id>');
    if (!opts.id || !opts.title) die('A message needs --id and --title.');
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(opts.id)) die('--id: letters, digits, dot, dash; 3–64 characters. People\'s dismissals are kept by it.');
    const level = opts.level || 'info';
    if (!['info', 'warning', 'critical'].includes(level)) die('--level is info, warning or critical.');
    const apps = String(opts.apps || 'desktop,server').split(',').map((s) => s.trim());
    if (!apps.every((x) => x === 'desktop' || x === 'server')) die('--apps lists desktop and/or server.');
    if (opts.sticky && level !== 'critical') die('Only a critical message can be undismissable (--sticky).');
    const msg = {
      id: opts.id, title: String(opts.title), body: textOf(opts.body), level, apps,
      versions: opts.versions ? String(opts.versions) : undefined,
      startsAt: isoDay(opts.starts), endsAt: isoDay(opts.ends),
      link: opts['link-url'] ? { label: String(opts['link-label'] || 'Read more'), url: String(opts['link-url']) } : undefined,
      dismissible: !opts.sticky,
    };
    m.messages = [...m.messages.filter((x) => x.id !== msg.id), JSON.parse(JSON.stringify(msg))];
    save(m); show(m); break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 22).map((l) => l.replace(/^ \*\/?\s?/, '')).join('\n'));
}

function compare(a, b) {
  const parse = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parse(a); const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  const preA = a.includes('-'); const preB = b.includes('-');
  if (preA !== preB) return preA ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}
