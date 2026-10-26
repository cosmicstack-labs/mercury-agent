/**
 * Installing, updating, rolling back and uninstalling plugins on disk.
 *
 * Every install is atomic: the package is downloaded and unpacked in
 * `.staging/`, checked (checksum, archive safety, manifest, compatibility,
 * native file checksums), and only then moved into place with a rename.
 * Anything that fails leaves the previous state untouched and the staging
 * folder removed. The previous version is kept for rollback.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { guardedFetch } from '../utils/ssrf.js';
import { logger } from '../utils/logger.js';
import {
  incompatibility, pluginDir, pluginVersionDir, readState, stagingRoot, withLock, writeState, currentPlatform,
} from './store.js';
import { manifestSchema, PLUGIN_ID_RE, type CatalogEntry, type PluginManifest, type PluginStateEntry } from './types.js';

const execFileAsync = promisify(execFile);

/** Hard limits that keep a hostile or broken package from filling the disk. */
export const LIMITS = {
  downloadBytes: 200 * 1024 * 1024,
  unpackedBytes: 400 * 1024 * 1024,
  files: 5000,
  downloadTimeoutMs: 5 * 60 * 1000,
};

export interface InstallOptions {
  /** Catalog entry when installing by id (gives the pinned checksum). */
  catalogEntry?: CatalogEntry;
  /** Expected SHA-256 of the archive for URL installs. */
  sha256?: string;
  /** Allow a different plugin id than expected (never for catalog installs). */
  expectId?: string;
  /** Reinstall even if this exact version is already installed. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

export interface InstallResult {
  id: string;
  version: string;
  previousVersion?: string;
  verified: boolean;
  manifest: PluginManifest;
  /** True when it was already installed at this version and nothing changed. */
  unchanged: boolean;
}

export type InstallSource =
  | { type: 'catalog'; entry: CatalogEntry }
  | { type: 'path'; path: string }
  | { type: 'url'; url: string }
  | { type: 'github'; repo: string; tag?: string };

/** Turn what the owner typed into a source. Catalog ids are resolved by the caller. */
export function parseSource(input: string): { kind: 'id'; id: string } | InstallSource {
  const s = input.trim();
  if (/^https:\/\//i.test(s)) return { type: 'url', url: s };
  if (/^http:\/\//i.test(s)) throw new Error('Plugin downloads must use HTTPS.');
  const gh = /^(?:github:|https?:\/\/github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:@([\w.-]+))?$/.exec(s);
  if (s.startsWith('github:') && gh) return { type: 'github', repo: gh[1], tag: gh[2] };
  const looksLikePath = s.startsWith('.') || s.startsWith('/') || s.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(s) || s.includes(sep) || /\.(tgz|tar\.gz)$/i.test(s);
  if (looksLikePath) return { type: 'path', path: expandHome(s) };
  if (PLUGIN_ID_RE.test(s)) return { kind: 'id', id: s };
  if (gh) return { type: 'github', repo: gh[1], tag: gh[2] };
  throw new Error(`Don't know how to install "${input}". Use a plugin id, a folder or .tgz path, an https:// URL, or github:owner/repo.`);
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : resolve(p);
}

// ── download ──────────────────────────────────────────────────────────────

async function download(url: string, dest: string, onProgress?: (m: string) => void): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LIMITS.downloadTimeoutMs);
  try {
    const res = await guardedFetch(url, ac.signal, { 'user-agent': 'mercury-plugin-installer', accept: 'application/octet-stream,*/*' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${new URL(url).host}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > LIMITS.downloadBytes) throw new Error(`Package is too large (${Math.round(declared / 1048576)} MB, limit ${LIMITS.downloadBytes / 1048576} MB).`);
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    let lastReport = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.downloadBytes) {
        ac.abort();
        throw new Error(`Package is too large (over ${LIMITS.downloadBytes / 1048576} MB).`);
      }
      hash.update(value);
      chunks.push(Buffer.from(value));
      if (onProgress && total - lastReport > 2 * 1048576) {
        lastReport = total;
        onProgress(`Downloaded ${(total / 1048576).toFixed(1)} MB`);
      }
    }
    writeFileSync(dest, Buffer.concat(chunks));
    return hash.digest('hex');
  } finally {
    clearTimeout(timer);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', () => res()).on('error', rej);
  });
  return hash.digest('hex');
}

async function githubReleaseAsset(repo: string, tag?: string): Promise<string> {
  const api = `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : 'latest'}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await guardedFetch(api, ac.signal, { accept: 'application/vnd.github+json', 'user-agent': 'mercury-plugin-installer' });
    if (!res.ok) throw new Error(`GitHub release not found for ${repo}${tag ? `@${tag}` : ''} (HTTP ${res.status}).`);
    const rel = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] };
    const assets = rel.assets ?? [];
    const platform = currentPlatform();
    const pick = assets.find((a) => a.name === `mercury-plugin-${platform}.tgz`) ?? assets.find((a) => a.name === 'mercury-plugin.tgz');
    if (!pick) throw new Error(`The ${repo} release has no "mercury-plugin.tgz" or "mercury-plugin-${platform}.tgz" asset.`);
    return pick.browser_download_url;
  } finally {
    clearTimeout(timer);
  }
}

// ── unpack and check ────────────────────────────────────────────────────

async function extractTgz(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  // System tar (bsdtar on macOS/Windows, GNU tar on Linux): both refuse
  // absolute paths and ".." members by default. We re-check every entry below.
  try {
    // Run from the archive's folder and pass only its name: GNU tar (e.g. Git
    // for Windows' tar on PATH) reads "C:\\…" as a remote host "C".
    await execFileAsync('tar', ['-xzf', basename(archive), '-C', into], { cwd: dirname(archive), timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (err) {
    throw new Error(`Couldn't unpack the plugin archive: ${(err as Error).message.split('\n')[0]}`);
  }
}

/**
 * Walk the unpacked tree and reject anything unsafe: symlinks, hard-linked
 * or special files, paths escaping the folder, and size/file-count bombs.
 */
export function checkTree(root: string): { files: number; bytes: number } {
  const realRoot = realpathSync(root);
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Plugin package contains a symbolic link (${relative(root, full)}); refusing to install.`);
      if (!st.isDirectory() && !st.isFile()) throw new Error(`Plugin package contains a special file (${relative(root, full)}).`);
      const real = realpathSync(full);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`Plugin package path escapes its folder (${relative(root, full)}).`);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (st.nlink > 1) throw new Error(`Plugin package contains a hard link (${relative(root, full)}).`);
      files += 1;
      bytes += st.size;
      if (files > LIMITS.files) throw new Error(`Plugin package has too many files (limit ${LIMITS.files}).`);
      if (bytes > LIMITS.unpackedBytes) throw new Error(`Plugin package is too large unpacked (limit ${LIMITS.unpackedBytes / 1048576} MB).`);
    }
  };
  walk(root);
  return { files, bytes };
}

/** npm-pack style archives put everything under one folder; find the manifest. */
function findPackageRoot(unpacked: string): string {
  if (existsSync(join(unpacked, 'mercury-plugin.json'))) return unpacked;
  const entries = readdirSync(unpacked).filter((n) => !n.startsWith('.'));
  if (entries.length === 1 && lstatSync(join(unpacked, entries[0])).isDirectory() && existsSync(join(unpacked, entries[0], 'mercury-plugin.json'))) {
    return join(unpacked, entries[0]);
  }
  throw new Error('No mercury-plugin.json found at the top of the plugin package.');
}

/** Parse and validate a manifest, with readable errors. */
export function loadManifest(dir: string): PluginManifest {
  const path = join(dir, 'mercury-plugin.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`mercury-plugin.json is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ');
    throw new Error(`Invalid mercury-plugin.json: ${first}`);
  }
  return parsed.data;
}

/** Everything that must hold before a package can be installed or started. */
export async function verifyPackage(dir: string, manifest: PluginManifest): Promise<void> {
  const why = incompatibility(manifest);
  if (why) throw new Error(`${manifest.name} ${manifest.version} can't run here: ${why}.`);
  const inside = (p: string) => {
    const full = resolve(dir, p);
    if (full !== dir && !full.startsWith(dir + sep)) throw new Error(`Manifest path escapes the plugin folder: ${p}`);
    return full;
  };
  if (manifest.kind === 'in-process') {
    const entry = inside(manifest.entry!);
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`Entry module "${manifest.entry}" is missing from the package.`);
    if (!/\.(m?js)$/.test(entry)) throw new Error('The entry module must be a bundled .js or .mjs file.');
  } else {
    const spec = manifest.server!.platforms?.[currentPlatform()] ?? manifest.server!;
    if (spec.command !== 'node') {
      const cmd = inside(spec.command);
      if (!existsSync(cmd)) throw new Error(`Server program "${spec.command}" is missing for ${currentPlatform()}.`);
      if (process.platform !== 'win32') chmodSync(cmd, 0o755);
    } else if (spec.args[0]) {
      const script = inside(spec.args[0]);
      if (!existsSync(script)) throw new Error(`Server script "${spec.args[0]}" is missing from the package.`);
    }
  }
  for (const [rel, expected] of Object.entries(manifest.checksums ?? {})) {
    const file = inside(rel);
    if (!existsSync(file)) throw new Error(`File "${rel}" listed in checksums is missing.`);
    const actual = await sha256File(file);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${rel}: the file was modified or corrupted.`);
  }
}

// ── install ────────────────────────────────────────────────────────────

function newStaging(): string {
  const dir = join(stagingRoot(), `${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove leftovers from interrupted installs. Safe to call any time. */
export function cleanStaging(): void {
  try { rmSync(stagingRoot(), { recursive: true, force: true }); } catch { /* best effort */ }
}

export async function installPackage(source: InstallSource, opts: InstallOptions = {}): Promise<InstallResult> {
  return withLock(async () => {
    const progress = opts.onProgress ?? (() => {});
    const staging = newStaging();
    try {
      let unpacked: string;
      let verified = false;
      let sourceRef: PluginStateEntry['source'];

      if (source.type === 'path') {
        if (!existsSync(source.path)) throw new Error(`No such file or folder: ${source.path}`);
        sourceRef = { type: 'path', ref: source.path };
        if (statSync(source.path).isDirectory()) {
          progress('Copying plugin folder');
          unpacked = join(staging, 'pkg');
          cpSync(source.path, unpacked, {
            recursive: true,
            verbatimSymlinks: true,
            // Skip VCS metadata; keep node_modules (out-of-process plugins may ship dependencies).
            filter: (src) => {
              const rel = relative(source.path, src);
              return rel === '' || !/(^|[\\/])\.git([\\/]|$)/.test(rel);
            },
          });
        } else {
          progress('Unpacking archive');
          unpacked = join(staging, 'pkg');
          await extractTgz(source.path, unpacked);
        }
      } else {
        let url: string;
        let expected: string | undefined;
        if (source.type === 'catalog') {
          const art = source.entry.artifacts?.[currentPlatform()] ?? source.entry.artifact;
          if (!art) throw new Error(`${source.entry.name} has no build for ${currentPlatform()}.`);
          url = art.url;
          expected = art.sha256;
          sourceRef = { type: 'catalog', ref: source.entry.id };
        } else if (source.type === 'github') {
          progress(`Looking up the ${source.repo} release`);
          url = await githubReleaseAsset(source.repo, source.tag);
          expected = opts.sha256;
          sourceRef = { type: 'github', ref: `${source.repo}${source.tag ? `@${source.tag}` : ''}` };
        } else {
          url = source.url;
          expected = opts.sha256;
          sourceRef = { type: 'url', ref: source.url };
        }
        progress(`Downloading from ${new URL(url).host}`);
        const archive = join(staging, 'package.tgz');
        const actual = await download(url, archive, progress);
        if (expected) {
          if (actual !== expected.toLowerCase()) throw new Error('Checksum mismatch: the download does not match the published SHA-256. Nothing was installed.');
          verified = source.type === 'catalog';
        }
        progress('Unpacking');
        unpacked = join(staging, 'pkg');
        await extractTgz(archive, unpacked);
      }

      progress('Checking the package');
      checkTree(unpacked);
      const root = findPackageRoot(unpacked);
      const manifest = loadManifest(root);
      if (source.type === 'catalog') {
        if (manifest.id !== source.entry.id) throw new Error(`Package id "${manifest.id}" doesn't match the catalog entry "${source.entry.id}".`);
        if (manifest.version !== source.entry.version) throw new Error(`Package version ${manifest.version} doesn't match the catalog (${source.entry.version}).`);
      }
      if (opts.expectId && manifest.id !== opts.expectId) throw new Error(`This package is "${manifest.id}", not "${opts.expectId}".`);
      await verifyPackage(root, manifest);

      const state = readState();
      const existing = state.plugins[manifest.id];
      if (existing && existing.version === manifest.version && !opts.force && existsSync(pluginVersionDir(manifest.id, manifest.version))) {
        return { id: manifest.id, version: manifest.version, verified: existing.verified, manifest, unchanged: true };
      }

      progress('Installing');
      const versionsDir = join(pluginDir(manifest.id), 'versions');
      mkdirSync(versionsDir, { recursive: true });
      mkdirSync(join(pluginDir(manifest.id), 'data'), { recursive: true });
      const target = pluginVersionDir(manifest.id, manifest.version);
      let trash: string | null = null;
      if (existsSync(target)) {
        trash = join(staging, 'replaced');
        renameSync(target, trash);
      }
      try {
        renameSync(root, target);
      } catch (err) {
        if (trash) renameSync(trash, target);
        throw err;
      }

      const now = new Date().toISOString();
      const previousVersion = existing && existing.version !== manifest.version ? existing.version : existing?.previousVersion;
      state.plugins[manifest.id] = {
        version: manifest.version,
        previousVersion,
        // A fresh install starts disabled; updates keep the owner's choice.
        enabled: existing?.enabled ?? false,
        kind: manifest.kind,
        source: sourceRef,
        verified,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        // Any disable reason from the old version doesn't carry over, except the owner's.
        disabled: existing?.disabled?.code === 'user' ? existing.disabled : undefined,
      };
      if (state.plugins[manifest.id].enabled) state.boot.lastChange = { id: manifest.id, at: now };
      writeState(state);
      pruneVersions(manifest.id, [manifest.version, previousVersion].filter(Boolean) as string[]);
      logger.info({ plugin: manifest.id, version: manifest.version, previousVersion, verified, source: sourceRef.type }, 'Plugin installed');
      return { id: manifest.id, version: manifest.version, previousVersion, verified, manifest, unchanged: false };
    } finally {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
}

/** Keep only the listed versions on disk (current and one previous). */
function pruneVersions(id: string, keep: string[]): void {
  const dir = join(pluginDir(id), 'versions');
  if (!existsSync(dir)) return;
  for (const v of readdirSync(dir)) {
    if (!keep.includes(v)) {
      try { rmSync(join(dir, v), { recursive: true, force: true }); } catch (err) { logger.warn({ err, plugin: id, version: v }, 'Could not prune old plugin version'); }
    }
  }
}

/** Switch back to the previous version, if it's still on disk. */
export async function rollbackPackage(id: string): Promise<{ from: string; to: string }> {
  return withLock(async () => {
    const state = readState();
    const entry = state.plugins[id];
    if (!entry) throw new Error(`Plugin "${id}" is not installed.`);
    const prev = entry.previousVersion;
    if (!prev || !existsSync(pluginVersionDir(id, prev))) throw new Error(`No previous version of "${id}" to roll back to.`);
    const manifest = loadManifest(pluginVersionDir(id, prev));
    await verifyPackage(pluginVersionDir(id, prev), manifest);
    const from = entry.version;
    entry.version = prev;
    entry.previousVersion = from;
    entry.kind = manifest.kind;
    entry.updatedAt = new Date().toISOString();
    if (entry.disabled && entry.disabled.code !== 'user') entry.disabled = undefined;
    if (entry.enabled) state.boot.lastChange = { id, at: entry.updatedAt };
    writeState(state);
    return { from, to: prev };
  });
}

/** Remove a plugin. Its data and settings are kept unless `purge` is set. */
export async function uninstallPackage(id: string, purge = false): Promise<{ removedData: boolean }> {
  return withLock(async () => {
    const state = readState();
    const had = !!state.plugins[id];
    delete state.plugins[id];
    if (state.boot.lastChange?.id === id) state.boot.lastChange = undefined;
    writeState(state);
    const dir = pluginDir(id);
    if (purge) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } else if (existsSync(join(dir, 'versions'))) {
      rmSync(join(dir, 'versions'), { recursive: true, force: true });
    }
    if (!had && !existsSync(dir)) throw new Error(`Plugin "${id}" is not installed.`);
    logger.info({ plugin: id, purge }, 'Plugin uninstalled');
    return { removedData: purge };
  });
}

/** The manifest of the installed (current) version, or null if missing or broken. */
export function installedManifest(id: string, version: string): PluginManifest | null {
  try {
    return loadManifest(pluginVersionDir(id, version));
  } catch {
    return null;
  }
}

export function packageSize(id: string, version: string): number {
  let bytes = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      const st = lstatSync(f);
      if (st.isDirectory()) walk(f);
      else bytes += st.size;
    }
  };
  try { walk(pluginVersionDir(id, version)); } catch { /* missing */ }
  return bytes;
}

