import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * Downloads that survive a bad connection: bytes go to `<file>.part` as they
 * arrive, and a retry (or the next attempt, even after a restart) asks for
 * the rest with an HTTP Range request. `If-Range` makes the server send the
 * whole file again if it changed in between, so two versions are never
 * stitched together. The finished file must match its SHA-256 from the
 * release's checksums.txt, or it's thrown away.
 */

export const REPO = 'cosmicstack-labs/mercury-agent';
const MAX_BYTES = 512 * 1024 * 1024;
const RETRIES = 5;
const STALL_MS = 30_000;

/** The file isn't there (404/410): the release isn't published yet, or never was. Not a failure of the update itself. */
export class NotAvailableError extends Error {
  readonly notAvailable = true;
}

export interface DownloadProgress { bytes: number; total: number | null }

export interface DownloadOptions {
  expectedSha256?: string;
  maxBytes?: number;
  retries?: number;
  stallMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (p: DownloadProgress) => void;
  /** Waits between retries (tests make it instant). */
  backoffMs?: (attempt: number) => number;
}

interface PartMeta { url: string; validator?: string; total?: number | null }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Cancelled')); }, { once: true });
});

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function readMeta(path: string): PartMeta | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as PartMeta; } catch { return null; }
}

class Permanent extends Error {}

/**
 * Download `url` to `dest`, resuming a `.part` left by an earlier try.
 * Returns the file's SHA-256. Throws NotAvailableError on 404/410.
 */
export async function downloadResumable(url: string, dest: string, opts: DownloadOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const part = `${dest}.part`;
  const metaPath = `${dest}.part.json`;
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(16_000, 1000 * 2 ** n));

  // Already here from an earlier attempt, and still the right file.
  if (existsSync(dest) && opts.expectedSha256) {
    const have = await sha256File(dest);
    if (have === opts.expectedSha256) {
      const size = statSync(dest).size;
      opts.onProgress?.({ bytes: size, total: size });
      return have;
    }
    rmSync(dest, { force: true });
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= (opts.retries ?? RETRIES); attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Cancelled');
    if (attempt > 0) await sleep(backoff(attempt - 1), opts.signal);
    try {
      await once(url, part, metaPath, fetchImpl, maxBytes, opts);
      const sum = await sha256File(part);
      if (opts.expectedSha256 && sum !== opts.expectedSha256) {
        // Corrupt or changed: start over, and count it as a try.
        rmSync(part, { force: true }); rmSync(metaPath, { force: true });
        throw new Error('The download did not match its checksum.');
      }
      renameSync(part, dest);
      rmSync(metaPath, { force: true });
      return sum;
    } catch (err) {
      if (err instanceof NotAvailableError || err instanceof Permanent || opts.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The download failed.');
}

async function once(url: string, part: string, metaPath: string, fetchImpl: typeof fetch, maxBytes: number, opts: DownloadOptions): Promise<void> {
  let meta = readMeta(metaPath);
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > 0 && (!meta || meta.url !== url)) { rmSync(part, { force: true }); have = 0; meta = null; }

  const headers: Record<string, string> = { 'user-agent': 'mercury-updater', accept: 'application/octet-stream' };
  if (have > 0) {
    headers.range = `bytes=${have}-`;
    if (meta?.validator) headers['if-range'] = meta.validator;
  }

  const stall = new AbortController();
  let stallTimer = setTimeout(() => stall.abort(new Error('The download stalled.')), opts.stallMs ?? STALL_MS);
  const onAbort = () => stall.abort(opts.signal?.reason ?? new Error('Cancelled'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: stall.signal });
    if (res.status === 404 || res.status === 410) throw new NotAvailableError(`Not found: ${url}`);
    if (res.status === 416 && meta?.total && have === meta.total) return; // already complete
    if (res.status === 416) { rmSync(part, { force: true }); throw new Error('The server refused to resume; starting over.'); }
    if (res.status === 401 || res.status === 403) throw new Permanent(`The server refused the download (${res.status}).`);
    if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);

    const resumed = res.status === 206;
    if (!resumed) have = 0;
    const length = Number(res.headers.get('content-length') ?? '') || null;
    const total = length !== null ? length + (resumed ? have : 0) : meta?.total ?? null;
    if (total !== null && total > maxBytes) throw new Permanent('The download is larger than any Mercury release; refused.');
    const validator = res.headers.get('etag') ?? res.headers.get('last-modified') ?? undefined;
    if (!resumed || !meta) {
      mkdirSync(join(part, '..'), { recursive: true });
      writeFileSync(metaPath, JSON.stringify({ url, validator, total } satisfies PartMeta));
    }

    const fd = openSync(part, resumed ? 'a' : 'w');
    let bytes = have;
    opts.onProgress?.({ bytes, total });
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(new Error('The download stalled.')), opts.stallMs ?? STALL_MS);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Permanent('The download is larger than any Mercury release; refused.');
        writeSync(fd, value);
        opts.onProgress?.({ bytes, total });
      }
    } finally {
      closeSync(fd);
    }
    if (total !== null && bytes < total) throw new Error('The download ended early.');
  } finally {
    clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ─── Release assets ──────────────────────────────────────────────────────────

/** The release asset for this computer (same names as scripts/install.sh and the desktop installer). */
export function assetName(platform = process.platform, arch = process.arch): string | null {
  if (process.env.MERCURY_ASSET) return process.env.MERCURY_ASSET;
  if (platform === 'darwin') return arch === 'arm64' ? 'mercury-macos-arm64' : 'mercury-macos-x64';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'mercury-linux-arm64';
    if (arch !== 'x64') return null;
    // Bun's x64 build needs AVX2; older CPUs take the baseline build.
    try { if (!/\bavx2\b/.test(readFileSync('/proc/cpuinfo', 'utf-8'))) return 'mercury-linux-x64-baseline'; } catch { /* assume modern */ }
    return 'mercury-linux-x64';
  }
  if (platform === 'win32' && arch === 'x64') return 'mercury-win-x64.exe';
  return null;
}

export function releaseBase(version: string, channel: 'stable' | 'dev'): string {
  const base = process.env.MERCURY_DOWNLOAD_BASE || `https://github.com/${REPO}/releases/download`;
  return channel === 'dev' ? `${base}/mercury-dev-latest` : `${base}/v${version.replace(/^v/, '')}`;
}

/** `sha256  name` lines → name → sha. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export function downloadsDir(version: string): string {
  return join(getMercuryHome(), 'updates', 'downloads', version.replace(/[^\w.\-+]/g, '_'));
}

export interface ReleaseFiles { dir: string; binary: string; web: string; asset: string }

/**
 * Fetch a release's binary and web dashboard, both checked against
 * checksums.txt. Progress is over both files together.
 */
export async function downloadRelease(version: string, channel: 'stable' | 'dev', opts: Omit<DownloadOptions, 'expectedSha256' | 'onProgress'> & { onProgress?: (p: DownloadProgress) => void } = {}): Promise<ReleaseFiles> {
  const asset = assetName();
  if (!asset) throw new Permanent('Mercury has no prebuilt build for this computer.');
  const base = releaseBase(version, channel);
  const fetchImpl = opts.fetchImpl ?? fetch;

  let sums: Map<string, string> | null = null;
  for (let i = 0; i < 3 && !sums; i++) {
    try {
      const res = await fetchImpl(`${base}/checksums.txt`, { redirect: 'follow', signal: opts.signal, headers: { 'user-agent': 'mercury-updater' } });
      if (res.status === 404 || res.status === 410) throw new NotAvailableError(`${version} has no published files yet.`);
      if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`);
      sums = parseChecksums(await res.text());
    } catch (err) {
      if (err instanceof NotAvailableError || opts.signal?.aborted || i === 2) throw err;
      await sleep((opts.backoffMs ?? ((n) => 1000 * 2 ** n))(i), opts.signal);
    }
  }
  const binSum = sums!.get(asset);
  const webSum = sums!.get('web.tar.gz');
  if (!binSum || !webSum) throw new NotAvailableError(`${version} has no ${binSum ? 'web dashboard' : asset} build yet.`);

  const dir = downloadsDir(version);
  mkdirSync(dir, { recursive: true });
  // Sizes aren't known until each starts; weight the binary at ~95%.
  let binP: DownloadProgress = { bytes: 0, total: null };
  let webP: DownloadProgress = { bytes: 0, total: null };
  const report = () => opts.onProgress?.({ bytes: binP.bytes + webP.bytes, total: binP.total !== null && webP.total !== null ? binP.total + webP.total : binP.total });
  const binary = join(dir, asset);
  const web = join(dir, 'web.tar.gz');
  await downloadResumable(`${base}/${asset}`, binary, { ...opts, expectedSha256: binSum, onProgress: (p) => { binP = p; report(); } });
  await downloadResumable(`${base}/web.tar.gz`, web, { ...opts, expectedSha256: webSum, onProgress: (p) => { webP = p; report(); } });
  return { dir, binary, web, asset };
}
