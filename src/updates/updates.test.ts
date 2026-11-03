import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { verifyMinisign } from './minisign.js';
import { UPDATE_PUBLIC_KEY } from './public-key.js';
import { compareVersions, getManifest, messagesFor, parseManifest, requiredFor, verifyManifest, versionMatches, type UpdateManifest } from './manifest.js';
import { downloadResumable, NotAvailableError, parseChecksums } from './download.js';
import { backupConfig, blockedFor, installBinary, restoreBinary, cancelServerUpdate, clearFailures, justUpdated, markJustUpdatedSeen, readJob, readUpdateState, reconcileUpdateJob, runUpdateWorker, startServerUpdate, type PrepareSteps, type UpdateJob, type WorkerSteps } from './server-updater.js';
import { detectInstall, type InstallInfo } from './install-kind.js';
import { startupNotices, updatesLine } from './notices.js';
import type { ServerUpdateStatus } from './status.js';

const ROOT = join(__dirname, '..', '..');
const previousHome = process.env.MERCURY_HOME;
let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-updates-'));
  process.env.MERCURY_HOME = home;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
afterAll(() => { if (previousHome === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previousHome; });

// ─── A minisign signer for tests (the format `tauri signer` writes) ─────────

function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const keyId = randomBytes(8);
  const pub = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`).toString('base64');
  const signFn = (data: string | Buffer) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sig = edSign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
    const trusted = 'timestamp:1793683429\tfile:manifest.json';
    const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    const text = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
    return Buffer.from(text).toString('base64');
  };
  return { pub, sign: signFn };
}

describe('minisign', () => {
  it('verifies a signature made by `tauri signer sign`, and refuses changed data or another key', () => {
    const dir = join(__dirname, 'fixtures');
    const data = readFileSync(join(dir, 'fixture.json'));
    const sig = readFileSync(join(dir, 'fixture.json.sig'), 'utf8');
    const pub = readFileSync(join(dir, 'throwaway.pub'), 'utf8');
    expect(verifyMinisign(data, sig, pub)).toMatchObject({ ok: true });
    expect(verifyMinisign(Buffer.concat([data, Buffer.from(' ')]), sig, pub)).toMatchObject({ ok: false, reason: /does not match/ });
    expect(verifyMinisign(data, sig, UPDATE_PUBLIC_KEY)).toMatchObject({ ok: false, reason: /different key/ });
  });

  it('refuses a swapped trusted comment', () => {
    const k = testKey();
    const sig = Buffer.from(k.sign('hello'), 'base64').toString().replace('file:manifest.json', 'file:other.json');
    expect(verifyMinisign('hello', Buffer.from(sig).toString('base64'), k.pub)).toMatchObject({ ok: false, reason: /comment/ });
  });

  it('the published manifest verifies with Mercury\'s key', () => {
    const text = readFileSync(join(ROOT, 'website', 'static', 'updates', 'manifest.json'), 'utf8');
    const sig = readFileSync(join(ROOT, 'website', 'static', 'updates', 'manifest.json.sig'), 'utf8');
    const v = verifyManifest(text, sig);
    expect('manifest' in v && v.manifest.schema).toBe(1);
  });

  it('the runtime and the desktop app trust the same key', () => {
    const conf = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(conf.plugins.updater.pubkey).toBe(UPDATE_PUBLIC_KEY);
  });
});

// ─── Versions and messages ───────────────────────────────────────────────────

describe('versions', () => {
  it('compares numerically, a dev build after its release', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.4.2', '1.4.2')).toBe(0);
    expect(compareVersions('1.4.2-dev.20261103.abc', '1.4.2')).toBe(1);
    expect(compareVersions('1.4.1', '1.4.2')).toBe(-1);
  });

  it('reads ranges; an unreadable range matches nobody', () => {
    expect(versionMatches('1.4.2', '<1.5.0')).toBe(true);
    expect(versionMatches('1.5.0', '<1.5.0')).toBe(false);
    expect(versionMatches('1.4.2', '>=1.4 <1.5')).toBe(true);
    expect(versionMatches('1.4.2', '=1.4.2')).toBe(true);
    expect(versionMatches('1.4.2', '')).toBe(true);
    expect(versionMatches('1.4.2', 'soon')).toBe(false);
  });

  const manifest = parseManifest(JSON.stringify({
    schema: 1, issuedAt: '2026-11-03T00:00:00Z',
    server: { channels: { stable: { version: '1.5.0' } }, minimum: { version: '1.4.2', severity: 'security', reason: 'Fixes a hole.' } },
    messages: [
      { id: 'a', title: 'For old servers', level: 'warning', apps: ['server'], versions: '<1.5.0' },
      { id: 'b', title: 'Desktop only', apps: ['desktop'] },
      { id: 'c', title: 'Later', startsAt: '2027-01-01T00:00:00Z' },
      { id: 'd', title: 'Over', endsAt: '2026-01-01T00:00:00Z' },
      { id: 'e', title: 'Sticky', level: 'info', dismissible: false },
      { id: 'f', title: 'Bad link', link: { url: 'javascript:alert(1)' } },
    ],
  }))!;

  it('says who must update', () => {
    expect(requiredFor(manifest, 'server', '1.4.1')).toMatchObject({ version: '1.4.2', severity: 'security' });
    expect(requiredFor(manifest, 'server', '1.4.2')).toBeNull();
    expect(requiredFor(manifest, 'desktop', '0.0.1')).toBeNull();
  });

  it('picks the messages for an app, version and time; only critical ones may refuse dismissal; links must be https', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(messagesFor(manifest, 'server', '1.4.2', now).map((m) => m.id)).toEqual(['a', 'e', 'f']);
    expect(messagesFor(manifest, 'server', '1.5.0', now).map((m) => m.id)).toEqual(['e', 'f']);
    expect(messagesFor(manifest, 'desktop', '0.1.0', now).map((m) => m.id)).toEqual(['b', 'e', 'f']);
    expect(manifest.messages!.find((m) => m.id === 'e')!.dismissible).toBe(true);
    expect(manifest.messages!.find((m) => m.id === 'f')!.link).toBeNull();
  });
});

// ─── Fetching the manifest ───────────────────────────────────────────────────

describe('getManifest', () => {
  const key = testKey();
  const make = (issuedAt: string, version = '1.5.0'): string => JSON.stringify({ schema: 1, issuedAt, server: { channels: { stable: { version } } } } satisfies Partial<UpdateManifest>);
  function fetchFrom(files: Record<string, string | number>) {
    return vi.fn(async (url: string | URL | Request) => {
      const v = files[String(url)];
      if (v === undefined || typeof v === 'number') return new Response('no', { status: typeof v === 'number' ? v : 404 });
      return new Response(v, { status: 200 });
    }) as unknown as typeof fetch;
  }
  const urls = ['https://a.test/m.json', 'https://b.test/m.json'];

  it('accepts a signed manifest and caches it for six hours', async () => {
    const text = make('2026-11-03T00:00:00Z');
    const f = fetchFrom({ [urls[0]]: text, [`${urls[0]}.sig`]: key.sign(text) });
    const c = await getManifest({ fetchImpl: f, urls, publicKey: key.pub, now: 1_000 });
    expect(c.manifest?.server?.channels?.stable?.version).toBe('1.5.0');
    await getManifest({ fetchImpl: f, urls, publicKey: key.pub, now: 1_000 + 60_000 });
    expect(f).toHaveBeenCalledTimes(2); // the file and its signature, once
  });

  it('ignores an unsigned or forged manifest, and uses the mirror when the first address fails', async () => {
    const text = make('2026-11-03T00:00:00Z');
    const forged = make('2026-11-03T00:00:00Z', '9.9.9');
    const f = fetchFrom({ [urls[0]]: forged, [`${urls[0]}.sig`]: key.sign(text), [urls[1]]: text, [`${urls[1]}.sig`]: key.sign(text) });
    const c = await getManifest({ fetchImpl: f, urls, publicKey: key.pub, now: 1_000 });
    expect(c.manifest?.server?.channels?.stable?.version).toBe('1.5.0');

    const none = await getManifest({ fetchImpl: fetchFrom({ [urls[0]]: forged, [`${urls[0]}.sig`]: key.sign(text) }), urls: [urls[0]], publicKey: key.pub, force: true, now: 1_000 + 120_000 });
    expect(none.manifest?.server?.channels?.stable?.version).toBe('1.5.0'); // the last good one stays
    expect(none.error).toMatch(/not signed/);
  });

  it('refuses to go back to an older manifest (replay)', async () => {
    const newer = make('2026-11-05T00:00:00Z', '1.6.0');
    const older = make('2026-11-01T00:00:00Z', '1.5.0');
    await getManifest({ fetchImpl: fetchFrom({ [urls[0]]: newer, [`${urls[0]}.sig`]: key.sign(newer) }), urls, publicKey: key.pub, now: 1 });
    const c = await getManifest({ fetchImpl: fetchFrom({ [urls[0]]: older, [`${urls[0]}.sig`]: key.sign(older) }), urls: [urls[0]], publicKey: key.pub, force: true, now: 1 + 120_000 });
    expect(c.manifest?.server?.channels?.stable?.version).toBe('1.6.0');
    expect(c.error).toMatch(/older/);
  });

  it('fails open offline, and limits forced checks to one a minute', async () => {
    const down = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const c = await getManifest({ fetchImpl: down, urls, publicKey: key.pub, force: true, now: 10_000 });
    expect(c.manifest).toBeNull();
    const calls = (down as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await getManifest({ fetchImpl: down, urls, publicKey: key.pub, force: true, now: 20_000 });
    expect((down as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });
});

// ─── Resumable downloads ─────────────────────────────────────────────────────

describe('downloadResumable', () => {
  const body = randomBytes(300_000);
  const sha = createHash('sha256').update(body).digest('hex');
  let server: Server;
  let base = '';
  let requests: Array<{ range?: string; ifRange?: string }> = [];
  let cutFirst = true;
  let etag = '"v1"';

  beforeEach(async () => {
    requests = []; cutFirst = true; etag = '"v1"';
    server = createServer((req, res) => {
      if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
      requests.push({ range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined });
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const honour = m && (!req.headers['if-range'] || req.headers['if-range'] === etag);
      const start = honour ? Number(m![1]) : 0;
      const chunk = body.subarray(start);
      res.writeHead(honour ? 206 : 200, { 'content-length': String(chunk.length), etag, 'accept-ranges': 'bytes' });
      if (cutFirst) {
        cutFirst = false;
        res.write(chunk.subarray(0, 100_000), () => res.destroy());
        return;
      }
      res.end(chunk);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('picks up where a dropped connection stopped, and checks the result', async () => {
    const dest = join(home, 'file.bin');
    const seen: number[] = [];
    const got = await downloadResumable(`${base}/file`, dest, { expectedSha256: sha, backoffMs: () => 1, onProgress: (p) => seen.push(p.bytes) });
    expect(got).toBe(sha);
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(requests[1].range).toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(requests[1].range!)![1])).toBeGreaterThan(0);
    expect(requests[1].ifRange).toBe('"v1"');
    expect(seen.at(-1)).toBe(body.length);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('starts over when the file changed in between (If-Range)', async () => {
    const dest = join(home, 'file.bin');
    // A first try that leaves a .part, then the file changes on the server.
    await expect(downloadResumable(`${base}/file`, dest, { expectedSha256: sha, retries: 0 })).rejects.toThrow();
    expect(existsSync(`${dest}.part`)).toBe(true);
    etag = '"v2"';
    await downloadResumable(`${base}/file`, dest, { expectedSha256: sha, backoffMs: () => 1 });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it('says "not available" for a missing file instead of retrying', async () => {
    await expect(downloadResumable(`${base}/missing`, join(home, 'x'), { backoffMs: () => 1 })).rejects.toBeInstanceOf(NotAvailableError);
  });

  it('reads checksums.txt', () => {
    const m = parseChecksums(`${'a'.repeat(64)}  mercury-macos-arm64\n${'b'.repeat(64)} *web.tar.gz\n`);
    expect(m.get('mercury-macos-arm64')).toBe('a'.repeat(64));
    expect(m.get('web.tar.gz')).toBe('b'.repeat(64));
  });
});

// ─── The update job ──────────────────────────────────────────────────────────

const INSTALL: InstallInfo = { kind: 'binary', channel: 'stable', canSelfUpdate: true, binaryPath: '/tmp/mercury-test-bin' };

function worker(over: Partial<WorkerSteps> = {}): WorkerSteps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    stop: async () => { calls.push('stop'); return true; },
    install: async () => { calls.push('install'); },
    start: async () => { calls.push('start'); },
    health: async (v) => { calls.push(`health ${v}`); return true; },
    restore: async () => { calls.push('restore'); },
    ...over,
  };
}

function prep(w: WorkerSteps, over: Partial<PrepareSteps> = {}): Partial<PrepareSteps> {
  return {
    busy: () => null,
    download: async (_job, onProgress) => { onProgress({ bytes: 50, total: 100 }); onProgress({ bytes: 100, total: 100 }); },
    backup: async () => {},
    handOver: async (job: UpdateJob) => { await runUpdateWorker(job.id, w, 50); return process.pid; },
    ...over,
  };
}

async function update(w: WorkerSteps, over: Partial<PrepareSteps> = {}, to = '1.5.0') {
  const r = startServerUpdate({ current: '1.4.2', to, install: INSTALL, steps: prep(w, over), idleWaitMs: 2000 });
  if (!r.ok) throw new Error(r.error);
  await r.done;
  return readJob()!;
}

describe('server update job', () => {
  it('downloads, hands over, installs, starts and checks; then says what\'s new once', async () => {
    const w = worker();
    const job = await update(w);
    expect(job.state).toBe('done');
    expect(job.percent).toBe(100);
    expect(w.calls).toEqual(['stop', 'install', 'start', 'health 1.5.0']);
    expect(justUpdated('1.5.0')).toMatchObject({ from: '1.4.2', to: '1.5.0' });
    markJustUpdatedSeen();
    expect(justUpdated('1.5.0')).toBeNull();
  });

  it('goes back to the old version when the new one doesn\'t answer, and counts the failure', async () => {
    const w = worker({ health: async (v) => { w.calls.push(`health ${v}`); return v === '1.4.2'; } });
    const job = await update(w);
    expect(job.state).toBe('rolled-back');
    expect(job.message).toMatch(/went back to 1\.4\.2/);
    expect(w.calls).toEqual(['stop', 'install', 'start', 'health 1.5.0', 'stop', 'restore', 'start', 'health 1.4.2']);
    expect(readUpdateState().failures['1.5.0'].count).toBe(1);
  });

  it('goes back when installing throws', async () => {
    const w = worker({ install: async () => { throw new Error('disk full'); } });
    const job = await update(w);
    expect(job.state).toBe('rolled-back');
    expect(job.error).toBe('disk full');
  });

  it('stops offering a version after three failures; trying by hand starts the count over', async () => {
    const bad = () => worker({ health: async (v) => v === '1.4.2' });
    for (let i = 0; i < 3; i++) await update(bad());
    expect(blockedFor('1.5.0')).toMatchObject({ failures: 3 });
    clearFailures('1.5.0');
    expect(blockedFor('1.5.0')).toBeNull();
  });

  it('a release that isn\'t published yet is "not available", not a failure, and nothing is stopped', async () => {
    const w = worker();
    const job = await update(w, { download: async () => { throw new NotAvailableError('404'); } });
    expect(job.state).toBe('failed');
    expect(job.notAvailable).toBe(true);
    expect(job.message).toMatch(/isn't downloadable yet/);
    expect(w.calls).toEqual([]);
    expect(readUpdateState().failures['1.5.0']).toBeUndefined();
  });

  it('waits for running work, can be cancelled before anything stops, and refuses a second update meanwhile', async () => {
    const w = worker();
    const r = startServerUpdate({ current: '1.4.2', to: '1.5.0', install: INSTALL, steps: prep(w, { busy: () => 'a reply' }), idleWaitMs: 60_000 });
    if (!r.ok) throw new Error(r.error);
    await new Promise((res) => setTimeout(res, 50));
    expect(readJob()!.message).toBe('Waiting for a reply to finish');
    const again = startServerUpdate({ current: '1.4.2', to: '1.5.0', install: INSTALL, steps: prep(w) });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(cancelServerUpdate().ok).toBe(true);
    await r.done;
    expect(readJob()!.state).toBe('cancelled');
    expect(w.calls).toEqual([]);
  });

  it('refuses installs that can\'t update themselves', () => {
    const r = startServerUpdate({ current: '1.4.2', to: '1.5.0', install: { kind: 'source', channel: 'stable', canSelfUpdate: false, cannotReason: 'git pull' } });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'git pull' });
  });

  it('at start-up, settles a job its worker left behind', () => {
    const base: UpdateJob = { id: 'j', from: '1.4.2', to: '1.5.0', state: 'checking', percent: 92, message: '', startedAt: 1, updatedAt: 1, log: [], attempt: 1, install: 'binary', channel: 'stable', workerPid: 999_999 };
    mkdirSync(join(home, 'updates'), { recursive: true });
    writeFileSync(join(home, 'updates', 'job.json'), JSON.stringify(base));
    reconcileUpdateJob('1.5.0');
    expect(readJob()!.state).toBe('done');
    writeFileSync(join(home, 'updates', 'job.json'), JSON.stringify({ ...base, state: 'installing' }));
    reconcileUpdateJob('1.4.2');
    expect(readJob()!.state).toBe('failed');
    writeFileSync(join(home, 'updates', 'job.json'), JSON.stringify({ ...base, state: 'downloading' }));
    reconcileUpdateJob('1.4.2');
    expect(readJob()!.state).toBe('cancelled');
  });

  it('swaps the binary and dashboard in, keeping the old ones beside them, and puts them back', () => {
    const bin = join(home, 'bin'); mkdirSync(join(bin, 'web'), { recursive: true });
    writeFileSync(join(bin, 'mercury'), 'old'); writeFileSync(join(bin, 'web', 'index.html'), 'old web');
    const dl = join(home, 'dl'); mkdirSync(join(dl, 'src', 'web'), { recursive: true });
    writeFileSync(join(dl, 'mercury-new'), 'new'); writeFileSync(join(dl, 'src', 'web', 'index.html'), 'new web');
    execFileSync('tar', ['-czf', join(dl, 'web.tar.gz'), '-C', join(dl, 'src'), 'web']);
    const job = { id: 'b', from: '1.4.2', to: '1.5.0', state: 'installing', percent: 78, message: '', startedAt: 1, updatedAt: 1, log: [], attempt: 1, install: 'binary', channel: 'stable', binaryPath: join(bin, 'mercury'), files: { binary: join(dl, 'mercury-new'), web: join(dl, 'web.tar.gz'), asset: 'mercury-new' } } satisfies UpdateJob;
    installBinary(job);
    expect(readFileSync(join(bin, 'mercury'), 'utf8')).toBe('new');
    expect(readFileSync(join(bin, 'mercury.prev'), 'utf8')).toBe('old');
    expect(readFileSync(join(bin, 'web', 'index.html'), 'utf8')).toBe('new web');
    expect(readFileSync(join(bin, 'web.prev', 'index.html'), 'utf8')).toBe('old web');
    restoreBinary(job);
    expect(readFileSync(join(bin, 'mercury'), 'utf8')).toBe('old');
    expect(readFileSync(join(bin, 'web', 'index.html'), 'utf8')).toBe('old web');
  });

  it('backs up settings files only', () => {
    writeFileSync(join(home, 'mercury.yaml'), 'a: 1');
    writeFileSync(join(home, '.env'), 'K=1');
    writeFileSync(join(home, 'remote.json'), '{}');
    writeFileSync(join(home, 'queue.db'), 'x');
    mkdirSync(join(home, 'memory'));
    expect(backupConfig('1.4.2', home)).toBe(3);
    expect(existsSync(join(home, 'updates', 'backup', '1.4.2', 'queue.db'))).toBe(false);
  });
});

// ─── Install kinds and notices ───────────────────────────────────────────────

describe('install kind', () => {
  it('tells a binary, a global npm install, a source checkout and a project install apart', () => {
    expect(detectInstall('1.4.2', { standalone: true, execPath: '/Users/a/.mercury/bin/mercury' })).toMatchObject({ kind: 'binary', canSelfUpdate: true, binaryPath: '/Users/a/.mercury/bin/mercury' });
    expect(detectInstall('1.4.2', { standalone: false, script: '/usr/local/lib/node_modules/@cosmicstack/mercury-agent/dist/index.js' })).toMatchObject({ kind: 'npm', packageDir: '/usr/local/lib/node_modules/@cosmicstack/mercury-agent' });
    expect(detectInstall('1.4.2', { standalone: false, script: join(ROOT, 'dist', 'index.js') })).toMatchObject({ kind: 'source', canSelfUpdate: false });
    expect(detectInstall('1.4.2', { standalone: false, script: '/srv/app/node_modules/@cosmicstack/mercury-agent/dist/index.js' })).toMatchObject({ kind: 'unknown', canSelfUpdate: false });
    expect(detectInstall('1.4.2-dev.20261103.abc', { standalone: true }).channel).toBe('dev');
  });
});

describe('notices', () => {
  const status = (over: Partial<ServerUpdateStatus>): ServerUpdateStatus => ({
    current: '1.4.2', channel: 'stable', install: 'binary', canSelfUpdate: true, latest: { version: '1.5.0' }, updateAvailable: true,
    required: null, manifestVerified: true, checkedAt: 1, job: null, blocked: null, justUpdated: null, messages: [], ...over,
  });

  it('an available update can be ignored; a required one can\'t', () => {
    expect(startupNotices(status({}), undefined, new Set()).notices[0]).toMatch(/Update available/);
    expect(startupNotices(status({}), '1.5.0', new Set()).notices).toEqual([]);
    const req = startupNotices(status({ required: { version: '1.4.3', severity: 'security', reason: 'Fixes a hole.' } }), '1.5.0', new Set());
    expect(req.notices[0]).toMatch(/Update required \(security\)/);
    expect(req.badge).toBe('1.5.0');
  });

  it('a blocked version isn\'t offered on its own', () => {
    expect(startupNotices(status({ blocked: { version: '1.5.0', failures: 3, lastError: 'x' } }), undefined, new Set()).notices).toEqual([]);
  });

  it('shows each message once, a sticky critical one every time', () => {
    const messages = [
      { id: 'm1', title: 'Hello', level: 'info' as const, dismissible: true },
      { id: 'm2', title: 'Patch now', level: 'critical' as const, dismissible: false },
    ];
    const first = startupNotices(status({ updateAvailable: false, messages }), undefined, new Set());
    expect(first.notices).toHaveLength(2);
    expect(first.shown).toEqual(['m1']);
    expect(startupNotices(status({ updateAvailable: false, messages }), undefined, new Set(['m1'])).notices).toHaveLength(1);
  });

  it('doctor\'s line', () => {
    expect(updatesLine(status({ updateAvailable: false })).text).toMatch(/up to date/);
    expect(updatesLine(status({})).level).toBe('note');
    expect(updatesLine(status({ required: { version: '1.4.3', severity: 'required', reason: 'Old.' } })).level).toBe('risk');
  });
});
