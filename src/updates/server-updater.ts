import { spawn, execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { NotAvailableError, downloadRelease, downloadsDir, type DownloadProgress } from './download.js';
import { NPM_PACKAGE, type InstallInfo, type InstallKind } from './install-kind.js';

/**
 * Updating the server without breaking it (UPDATES.md §2).
 *
 * The running Mercury does the safe half: waits for running work, downloads
 * (resumable, checksum-verified) and backs up the settings files, all while
 * it keeps serving. Then a detached worker (`mercury __update-worker <id>`)
 * does the half Mercury can't do to itself: stop it, put the new version in
 * place (the old one kept beside it), start it and check it answers as the
 * new version. If it doesn't within 90 seconds, the worker puts the old
 * version and settings back and starts that: the update rolls itself back.
 *
 * The job lives in ~/.mercury/updates/job.json, so whichever Mercury is up
 * (new or restored) can say how it went. A version that fails three times is
 * "blocked": Mercury stops offering it on its own until someone retries.
 * A version that isn't downloadable yet is not a failure: nothing changed.
 */

export type JobState =
  | 'waiting-idle' | 'downloading' | 'verifying' | 'backing-up' | 'stopping'
  | 'installing' | 'starting' | 'checking'
  | 'done' | 'rolled-back' | 'failed' | 'cancelled';

export interface UpdateJob {
  id: string;
  from: string;
  to: string;
  state: JobState;
  percent: number | null;
  bytes?: number;
  total?: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  log: string[];
  attempt: number;
  install: InstallKind;
  channel: 'stable' | 'dev';
  /** The worker that owns the job from 'stopping' on. */
  workerPid?: number;
  /** The version isn't published (yet); nothing was changed. */
  notAvailable?: boolean;
  dryRun?: boolean;
  /** Where the downloaded release is (binary installs). */
  files?: { binary: string; web: string; asset: string };
  binaryPath?: string;
  packageDir?: string;
}

export const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'rolled-back', 'failed', 'cancelled']);
const BEFORE_STOP: ReadonlySet<JobState> = new Set(['waiting-idle', 'downloading', 'verifying', 'backing-up']);
export const MAX_FAILURES = 3;
const IDLE_WAIT_MS = 10 * 60_000;
export const HEALTH_TIMEOUT_MS = 90_000;
const JUST_UPDATED_DAYS = 7;

/** Overall progress at the start of each step. Downloading fills 2→60. */
const STEP_PERCENT: Record<JobState, number> = {
  'waiting-idle': 0, downloading: 2, verifying: 62, 'backing-up': 66, stopping: 70,
  installing: 78, starting: 86, checking: 92, done: 100, 'rolled-back': 100, failed: 100, cancelled: 100,
};

const STEP_MESSAGE: Partial<Record<JobState, string>> = {
  'waiting-idle': 'Waiting for running work to finish',
  downloading: 'Downloading',
  verifying: 'Checking the download',
  'backing-up': 'Backing up your settings',
  stopping: 'Stopping Mercury',
  installing: 'Installing',
  starting: 'Starting the new version',
  checking: 'Checking the new version works',
};

// ─── Files ───────────────────────────────────────────────────────────────────

export function updatesHome(): string { return join(getMercuryHome(), 'updates'); }
const jobPath = () => join(updatesHome(), 'job.json');
const statePath = () => join(updatesHome(), 'state.json');
export const backupDir = (version: string) => join(updatesHome(), 'backup', version.replace(/[^\w.\-+]/g, '_'));

function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

export function readJob(): UpdateJob | null {
  try { return existsSync(jobPath()) ? JSON.parse(readFileSync(jobPath(), 'utf-8')) as UpdateJob : null; } catch { return null; }
}

function saveJob(job: UpdateJob): void {
  job.updatedAt = Date.now();
  try { writeAtomic(jobPath(), job); } catch (err) { logger.warn({ err: String(err) }, 'updates: saving the job failed'); }
}

export interface UpdateStateFile {
  failures: Record<string, { count: number; lastError: string; at: number }>;
  justUpdated?: { from: string; to: string; at: number; seen?: boolean } | null;
}

export function readUpdateState(): UpdateStateFile {
  try {
    if (existsSync(statePath())) {
      const s = JSON.parse(readFileSync(statePath(), 'utf-8')) as UpdateStateFile;
      return { failures: s.failures ?? {}, justUpdated: s.justUpdated ?? null };
    }
  } catch { /* corrupt → clean */ }
  return { failures: {} };
}

function saveUpdateState(s: UpdateStateFile): void {
  try { writeAtomic(statePath(), s); } catch { /* best effort */ }
}

function recordFailure(version: string, error: string): void {
  const s = readUpdateState();
  const f = s.failures[version] ?? { count: 0, lastError: '', at: 0 };
  s.failures[version] = { count: f.count + 1, lastError: error, at: Date.now() };
  saveUpdateState(s);
}

/** Three failures at this version: don't offer it on our own any more. */
export function blockedFor(version: string | null | undefined): { version: string; failures: number; lastError: string } | null {
  if (!version) return null;
  const f = readUpdateState().failures[version];
  return f && f.count >= MAX_FAILURES ? { version, failures: f.count, lastError: f.lastError } : null;
}

/** "Try again" by hand starts the count over. */
export function clearFailures(version: string): void {
  const s = readUpdateState();
  if (s.failures[version]) { delete s.failures[version]; saveUpdateState(s); }
}

/** The last successful update, for "what's new", until it's been seen (or a week passed). */
export function justUpdated(current: string): { from: string; to: string; at: number } | null {
  const j = readUpdateState().justUpdated;
  if (!j || j.seen || j.to !== current) return null;
  if (Date.now() - j.at > JUST_UPDATED_DAYS * 86_400_000) return null;
  return { from: j.from, to: j.to, at: j.at };
}

export function markJustUpdatedSeen(): void {
  const s = readUpdateState();
  if (s.justUpdated && !s.justUpdated.seen) { s.justUpdated.seen = true; saveUpdateState(s); }
}

// ─── Job bookkeeping ─────────────────────────────────────────────────────────

function step(job: UpdateJob, state: JobState, message?: string): void {
  job.state = state;
  job.percent = STEP_PERCENT[state];
  job.message = message ?? STEP_MESSAGE[state] ?? job.message;
  log(job, job.message);
  saveJob(job);
}

function log(job: UpdateJob, line: string): void {
  const stamp = new Date().toTimeString().slice(0, 8);
  job.log.push(`${stamp} ${line}`);
  if (job.log.length > 40) job.log.splice(0, job.log.length - 40);
}

function finish(job: UpdateJob, state: 'done' | 'rolled-back' | 'failed' | 'cancelled', message: string, error?: string): void {
  if (error) job.error = error;
  step(job, state, message);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/** A job is running when it isn't finished and whoever owns it is alive. */
export function runningJob(): UpdateJob | null {
  const job = readJob();
  if (!job || TERMINAL.has(job.state)) return null;
  if (BEFORE_STOP.has(job.state)) return active?.id === job.id ? job : null;
  // Just handed over: the worker hasn't written its pid yet.
  if (job.state === 'stopping' && !job.workerPid && Date.now() - job.updatedAt < 30_000) return job;
  return isAlive(job.workerPid) ? job : null;
}

// ─── Steps (replaceable in tests) ────────────────────────────────────────────

export interface PrepareSteps {
  /** What's still running ("a reply in Telegram"), or null when idle. */
  busy(): string | null;
  /** Fetch what the install needs, before anything is stopped. */
  download(job: UpdateJob, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<void>;
  backup(job: UpdateJob): Promise<void>;
  /** Start the worker that stops, installs, starts and checks. Returns its pid. */
  handOver(job: UpdateJob): Promise<number>;
}

export interface WorkerSteps {
  stop(): Promise<boolean>;
  install(job: UpdateJob): Promise<void>;
  start(): Promise<void>;
  /** True once Mercury answers as `version`. */
  health(version: string, timeoutMs: number): Promise<boolean>;
  /** Put the old version and settings back. */
  restore(job: UpdateJob): Promise<void>;
}

let busyProbe: () => string | null = () => null;
/** The runtime says what counts as busy (a reply, research, a bot run). */
export function setUpdateBusyProbe(fn: () => string | null): void { busyProbe = fn; }

export const isDryRun = () => process.env.MERCURY_UPDATE_DRY_RUN === '1';

// ─── The running Mercury's half ─────────────────────────────────────────────

let active: { id: string; abort: AbortController } | null = null;

export interface StartOptions {
  current: string;
  to: string;
  install: InstallInfo;
  /** Don't wait for running work. */
  now?: boolean;
  /** Started by hand: a blocked version gets a fresh count. */
  manual?: boolean;
  steps?: Partial<PrepareSteps>;
  idleWaitMs?: number;
}

export type StartResult = { ok: true; job: UpdateJob; done: Promise<void> } | { ok: false; status: 400 | 409; error: string; job?: UpdateJob };

export function startServerUpdate(opts: StartOptions): StartResult {
  const running = runningJob();
  if (running) return { ok: false, status: 409, error: 'An update is already running.', job: running };
  if (!opts.install.canSelfUpdate) return { ok: false, status: 400, error: opts.install.cannotReason ?? 'This Mercury can\'t update itself.' };
  if (!opts.to) return { ok: false, status: 400, error: 'No newer version is known.' };
  if (opts.manual) clearFailures(opts.to);

  const prev = readJob();
  const job: UpdateJob = {
    id: randomUUID(),
    from: opts.current,
    to: opts.to,
    state: 'waiting-idle',
    percent: 0,
    message: STEP_MESSAGE['waiting-idle']!,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    log: [],
    attempt: prev && prev.to === opts.to ? prev.attempt + 1 : 1,
    install: opts.install.kind,
    channel: opts.install.channel,
    binaryPath: opts.install.binaryPath,
    packageDir: opts.install.packageDir,
    ...(isDryRun() ? { dryRun: true } : {}),
  };
  log(job, `Update ${opts.current} → ${opts.to} (${opts.install.kind}${isDryRun() ? ', dry run' : ''})`);
  saveJob(job);
  const abort = new AbortController();
  active = { id: job.id, abort };
  const steps = { ...realPrepareSteps(), ...opts.steps };
  const done = prepare(job, steps, abort.signal, opts.now ? 0 : opts.idleWaitMs ?? IDLE_WAIT_MS).finally(() => {
    if (active?.id === job.id) active = null;
  });
  return { ok: true, job, done };
}

/** Cancel, only while nothing has been stopped yet. */
export function cancelServerUpdate(): { ok: boolean; error?: string; job?: UpdateJob } {
  const job = readJob();
  if (!job || TERMINAL.has(job.state)) return { ok: false, error: 'No update is running.' };
  if (!BEFORE_STOP.has(job.state) || active?.id !== job.id) return { ok: false, error: 'The update is already installing and can\'t be stopped now.', job };
  active.abort.abort(new Error('Cancelled'));
  return { ok: true, job };
}

async function prepare(job: UpdateJob, steps: PrepareSteps, signal: AbortSignal, idleWaitMs: number): Promise<void> {
  try {
    const until = Date.now() + idleWaitMs;
    let said = '';
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const busy = steps.busy();
      if (!busy) break;
      if (Date.now() >= until) { log(job, `Still busy (${busy}) after waiting; updating anyway`); break; }
      const msg = `Waiting for ${busy} to finish`;
      if (msg !== said) { said = msg; job.message = msg; log(job, msg); saveJob(job); }
      await new Promise((r) => setTimeout(r, 1000));
    }

    step(job, 'downloading', `Downloading Mercury ${job.to}`);
    let lastSave = 0;
    await steps.download(job, (p) => {
      job.bytes = p.bytes;
      if (p.total) job.total = p.total;
      job.percent = p.total ? 2 + Math.round(Math.min(1, p.bytes / p.total) * 58) : 2;
      if (Date.now() - lastSave > 500) { lastSave = Date.now(); saveJob(job); }
    }, signal);
    if (signal.aborted) throw signal.reason;

    step(job, 'verifying');
    step(job, 'backing-up');
    await steps.backup(job);
    if (signal.aborted) throw signal.reason;

    step(job, 'stopping', 'Handing over to the updater');
    // From here the worker owns job.json; writing it again could undo its progress.
    await steps.handOver(job);
  } catch (err) {
    if (signal.aborted) { finish(job, 'cancelled', 'Update cancelled. Nothing was changed.'); return; }
    if (err instanceof NotAvailableError || (err as { notAvailable?: boolean })?.notAvailable) {
      job.notAvailable = true;
      finish(job, 'failed', `${job.to} isn't downloadable yet. Nothing was changed; try again later.`, errText(err));
      return;
    }
    recordFailure(job.to, errText(err));
    finish(job, 'failed', `The update failed before anything was changed: ${errText(err)}`, errText(err));
  }
}

// ─── The worker's half ───────────────────────────────────────────────────────

export async function runUpdateWorker(jobId: string, steps: WorkerSteps = realWorkerSteps(), healthMs = HEALTH_TIMEOUT_MS): Promise<UpdateJob | null> {
  const job = readJob();
  if (!job || job.id !== jobId || TERMINAL.has(job.state)) return job;
  job.workerPid = process.pid;
  if (isDryRun()) job.dryRun = true;
  saveJob(job);

  step(job, 'stopping');
  let stopped = false;
  try { stopped = await steps.stop(); } catch (err) { log(job, `Stop failed: ${errText(err)}`); }
  if (!stopped) {
    recordFailure(job.to, 'Mercury could not be stopped');
    finish(job, 'failed', 'Mercury could not be stopped, so nothing was changed.', 'Mercury could not be stopped');
    return job;
  }

  let failure = '';
  try {
    step(job, 'installing', `Installing Mercury ${job.to}`);
    await steps.install(job);
    step(job, 'starting');
    await steps.start();
    step(job, 'checking');
    if (await steps.health(job.to, healthMs)) {
      const s = readUpdateState();
      delete s.failures[job.to];
      if (!job.dryRun) s.justUpdated = { from: job.from, to: job.to, at: Date.now() };
      saveUpdateState(s);
      cleanupAfterSuccess(job);
      finish(job, 'done', job.dryRun ? `Dry run finished: every step ran, nothing was changed.` : `Mercury ${job.to} is running.`);
      return job;
    }
    failure = `Mercury ${job.to} did not start properly within ${Math.round(healthMs / 1000)} seconds.`;
  } catch (err) {
    failure = errText(err);
  }

  // Going back.
  log(job, failure);
  recordFailure(job.to, failure);
  job.message = `Going back to ${job.from}`;
  saveJob(job);
  try {
    await steps.stop().catch(() => false);
    await steps.restore(job);
    await steps.start();
    if (await steps.health(job.from, healthMs)) {
      finish(job, 'rolled-back', `The update didn't work, so Mercury went back to ${job.from}. Nothing was lost.`, failure);
    } else {
      finish(job, 'failed', `The update didn't work and Mercury ${job.from} didn't come back on its own. Run \`mercury start\`.`, failure);
    }
  } catch (err) {
    finish(job, 'failed', `The update didn't work and going back failed too (${errText(err)}). Run \`mercury upgrade --force\` or reinstall from mercuryagent.sh.`, failure);
  }
  return job;
}

function cleanupAfterSuccess(job: UpdateJob): void {
  // Keep the backup of the version we came from; drop older ones and finished downloads.
  try {
    const root = join(updatesHome(), 'backup');
    if (existsSync(root)) for (const d of readdirSync(root)) if (d !== basename(backupDir(job.from))) rmSync(join(root, d), { recursive: true, force: true });
    rmSync(downloadsDir(job.to), { recursive: true, force: true });
  } catch { /* best effort */ }
}

/**
 * At start-up: a job the last Mercury left half done. Before the stop, the
 * Mercury that ran it is gone, so it never got further (nothing changed).
 * After it, the worker owns it; if the worker is gone too, the version we
 * are running tells how it ended.
 */
export function reconcileUpdateJob(current: string): void {
  const job = readJob();
  if (!job || TERMINAL.has(job.state)) return;
  if (BEFORE_STOP.has(job.state)) {
    if (active?.id === job.id) return;
    finish(job, 'cancelled', 'Mercury restarted before the update was installed. Nothing was changed.');
    return;
  }
  if (isAlive(job.workerPid) && job.workerPid !== process.pid) return;
  if (job.state === 'stopping' && !job.workerPid && Date.now() - job.updatedAt < 30_000) return;
  if (current === job.to) {
    const s = readUpdateState();
    delete s.failures[job.to];
    s.justUpdated = { from: job.from, to: job.to, at: Date.now() };
    saveUpdateState(s);
    finish(job, 'done', `Mercury ${job.to} is running.`);
  } else {
    recordFailure(job.to, 'The updater stopped halfway');
    finish(job, 'failed', `The update stopped halfway; Mercury is still ${current}.`, 'The updater stopped halfway');
  }
}

// ─── Real steps ──────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], job?: UpdateJob, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf-8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (job && out) for (const l of out.split('\n').slice(-6)) log(job, l.slice(0, 200));
      if (err) reject(Object.assign(new Error(out.split('\n').filter(Boolean).slice(-1)[0] || err.message), { output: out }));
      else resolve(out);
    });
  });
}

/** Settings files at the top of ~/.mercury (not folders, not databases). */
export function backupConfig(version: string, home = getMercuryHome()): number {
  const dest = backupDir(version);
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const name of readdirSync(home)) {
    const src = join(home, name);
    if (!/(\.json|\.ya?ml|\.env|^\.env.*)$/i.test(name) && name !== '.env') continue;
    try {
      const st = statSync(src);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      copyFileSync(src, join(dest, name));
      n++;
    } catch { /* skip */ }
  }
  return n;
}

export function restoreConfig(version: string, home = getMercuryHome()): number {
  const src = backupDir(version);
  if (!existsSync(src)) return 0;
  let n = 0;
  for (const name of readdirSync(src)) {
    try { copyFileSync(join(src, name), join(home, name)); n++; } catch { /* skip */ }
  }
  return n;
}

function realPrepareSteps(): PrepareSteps {
  return {
    busy: () => { try { return busyProbe(); } catch { return null; } },
    async download(job, onProgress, signal) {
      if (job.install === 'binary') {
        const files = await downloadRelease(job.to, job.channel, { signal, onProgress });
        job.files = { binary: files.binary, web: files.web, asset: files.asset };
        return;
      }
      if (job.install === 'npm') {
        // The exact version must exist, and run on this Node, before anything stops.
        const spec = `${NPM_PACKAGE}@${job.to}`;
        let found = '';
        try { found = await run('npm', ['view', spec, 'version'], undefined, 60_000); } catch { /* checked below */ }
        if (!found.trim()) throw new NotAvailableError(`${job.to} isn't on npm yet.`);
        if (!process.versions.bun) {
          let required = '';
          try { required = await run('npm', ['view', spec, 'engines.node'], undefined, 60_000); } catch { /* unknown */ }
          const need = Number((required.match(/(\d+)/) || [])[1] || 0);
          const have = Number(process.versions.node.split('.')[0]);
          if (need && have < need) throw Object.assign(new Error(`${job.to} needs Node.js ${need}+; this is Node ${process.version}. Update Node first.`), { permanent: true });
        }
        onProgress({ bytes: 0, total: null });
        // Into npm's cache now, so the install itself is quick and works offline.
        await run('npm', ['cache', 'add', spec], job);
        onProgress({ bytes: 1, total: 1 });
      }
    },
    async backup(job) {
      const n = backupConfig(job.from);
      log(job, `Backed up ${n} settings file${n === 1 ? '' : 's'}`);
    },
    async handOver(job) {
      const { buildDaemonSpawnArgs } = await import('../cli/daemon.js');
      const { command, args } = buildDaemonSpawnArgs();
      let cmd = command;
      let argv = [...args.slice(0, -2), '__update-worker', job.id];
      // systemd stops everything in the service's group when Mercury exits;
      // the worker gets its own unit so it outlives the stop.
      if (process.platform === 'linux') {
        const { isServiceInstalled } = await import('../cli/service.js');
        if (isServiceInstalled() && existsSync('/usr/bin/systemd-run')) {
          argv = ['--user', '--collect', '--quiet', `--unit=mercury-update-${job.id.slice(0, 8)}`, cmd, ...argv];
          cmd = '/usr/bin/systemd-run';
        }
      }
      mkdirSync(updatesHome(), { recursive: true });
      const out = openSync(join(updatesHome(), 'worker.log'), 'a');
      const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', out, out], env: { ...process.env }, windowsHide: true });
      child.unref();
      if (!child.pid) throw new Error('The updater could not be started.');
      log(job, `Updater started (pid ${child.pid})`);
      return child.pid;
    },
  };
}

/** Is Mercury running (as the daemon or the login service)? */
async function runtimeAlive(): Promise<boolean> {
  try {
    const d = await import('../cli/daemon.js');
    const sv = await import('../cli/service.js');
    return d.getDaemonStatus().running || d.getForegroundRuntimeStatus().running || (sv.isServiceInstalled() && sv.isServiceRunning());
  } catch {
    return true; // can't tell: keep waiting for health
  }
}

/** `mercury --version` of the program installed now (what the next start runs), or null. */
async function installedVersion(): Promise<string | null> {
  const { buildDaemonSpawnArgs } = await import('../cli/daemon.js');
  const { command, args } = buildDaemonSpawnArgs();
  const argv = [...args.slice(0, -2), '--version'];
  return new Promise((resolve) => {
    execFile(command, argv, { timeout: 15_000, encoding: 'utf-8' }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
      resolve(!err && /^\d+\.\d+\.\d+/.test(line) ? line : null);
    });
  });
}

async function healthVersion(): Promise<{ version: string; booting: boolean } | null> {
  const { getWebPort } = await import('../web/auth.js');
  try {
    const res = await fetch(`http://127.0.0.1:${getWebPort()}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const b = await res.json() as { version?: string; booting?: boolean };
    return { version: String(b.version ?? ''), booting: !!b.booting };
  } catch {
    return null;
  }
}

export function realWorkerSteps(): WorkerSteps {
  if (isDryRun()) {
    return {
      stop: async () => true,
      install: async () => { await new Promise((r) => setTimeout(r, 300)); },
      start: async () => {},
      health: async () => true,
      restore: async () => {},
    };
  }
  return {
    async stop() {
      const d = await import('../cli/daemon.js');
      const s = await import('../cli/service.js');
      if (d.getDaemonStatus().running) await d.stopDaemon();
      if (d.getForegroundRuntimeStatus().running) await d.stopForegroundRuntime();
      if (s.isServiceRunning()) s.stopService();
      return !d.getDaemonStatus().running && !d.getForegroundRuntimeStatus().running;
    },
    async install(job) {
      if (job.install === 'binary') return installBinary(job);
      if (job.install === 'npm') return installNpm(job, job.to);
      throw new Error('This install can\'t be updated automatically.');
    },
    async start() {
      const s = await import('../cli/service.js');
      if (s.isServiceInstalled()) { s.restartService(); return; }
      const d = await import('../cli/daemon.js');
      d.ensureDaemonRunning();
    },
    async health(version, timeoutMs) {
      const started = Date.now();
      const until = started + timeoutMs;
      let installed: string | null | undefined;
      let goneSince: number | null = null;
      while (Date.now() < until) {
        // A new version that crashed on start doesn't get the full wait: no
        // process for 5 s (after a 10 s grace) is an answer already.
        if (Date.now() - started > 10_000 && !(await runtimeAlive())) {
          goneSince ??= Date.now();
          if (Date.now() - goneSince > 5_000) return false;
        } else goneSince = null;
        const h = await healthVersion();
        if (h && !h.booting) {
          if (h.version === version) return true;
          // Standalone builds up to 1.4.2 answer health with an empty version:
          // then the program now installed says which one it is.
          if (h.version === '') {
            installed ??= await installedVersion();
            if (installed === version) return true;
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    },
    async restore(job) {
      if (job.install === 'binary') restoreBinary(job);
      else if (job.install === 'npm') await installNpm(job, job.from);
      const n = restoreConfig(job.from);
      log(job, `Restored ${n} settings file${n === 1 ? '' : 's'}`);
    },
  };
}

const prevOf = (p: string) => `${p}.prev`;

export function installBinary(job: UpdateJob, run = runTar): void {
  if (!job.files || !job.binaryPath) throw new Error('The download is missing.');
  const bin = job.binaryPath;
  const binDir = dirname(bin);
  const stage = join(dirname(job.files.web), 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run(job.files.web, stage);
  if (!existsSync(join(stage, 'web'))) throw new Error('The web dashboard archive was empty.');

  // The old version stays beside the new one until the next update.
  rmSync(prevOf(bin), { force: true });
  renameSync(bin, prevOf(bin));
  try {
    copyFileSync(job.files.binary, bin);
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
  } catch (err) {
    try { rmSync(bin, { force: true }); renameSync(prevOf(bin), bin); } catch { /* restore below */ }
    throw err;
  }
  const web = join(binDir, 'web');
  rmSync(prevOf(web), { recursive: true, force: true });
  if (existsSync(web)) renameSync(web, prevOf(web));
  renameSync(join(stage, 'web'), web);
  if (process.platform === 'darwin') {
    try { execFile('xattr', ['-d', 'com.apple.quarantine', bin], () => {}); } catch { /* not quarantined */ }
  }
  log(job, `Installed ${job.files.asset} at ${bin}`);
}

export function restoreBinary(job: UpdateJob): void {
  if (!job.binaryPath) return;
  const bin = job.binaryPath;
  if (existsSync(prevOf(bin))) {
    rmSync(bin, { force: true });
    renameSync(prevOf(bin), bin);
  }
  const web = join(dirname(bin), 'web');
  if (existsSync(prevOf(web))) {
    rmSync(web, { recursive: true, force: true });
    renameSync(prevOf(web), web);
  }
  log(job, `Restored ${basename(bin)} ${job.from}`);
}

function runTar(archive: string, dest: string): void {
  // Same as the installer: refuse absolute paths and `..` in the archive.
  const list = execFileSync('tar', ['-tzf', archive], { encoding: 'utf-8' });
  if (list.split('\n').some((l) => l.startsWith('/') || l.split('/').includes('..'))) throw new Error('The web dashboard archive has unsafe paths.');
  execFileSync('tar', ['-xzf', archive, '-C', dest]);
}

async function installNpm(job: UpdateJob, version: string): Promise<void> {
  const spec = `${NPM_PACKAGE}@${version}`;
  try {
    await run('npm', ['i', '-g', spec], job);
  } catch (err) {
    // A half-removed package dir makes npm fail with ENOTEMPTY; clear it and try once more.
    if (/ENOTEMPTY/.test(String((err as { output?: string }).output ?? err)) && job.packageDir) {
      log(job, 'Clearing a leftover package folder and retrying');
      rmSync(job.packageDir, { recursive: true, force: true });
      await run('npm', ['i', '-g', spec], job);
      return;
    }
    throw err;
  }
}
