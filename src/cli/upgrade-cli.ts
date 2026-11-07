import type { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { getWebPort, readAttachToken } from '../web/auth.js';
import { detectInstall, type InstallInfo } from '../updates/install-kind.js';
import { serverUpdateStatus, targetVersion, type ServerUpdateStatus } from '../updates/status.js';
import { HEALTH_TIMEOUT_MS, readJob, realWorkerSteps, runUpdateWorker, startServerUpdate, TERMINAL, type UpdateJob, type WorkerSteps } from '../updates/server-updater.js';

/**
 * `mercury upgrade` and `mercury update`: the same fail-safe update the
 * apps start (UPDATES.md §2), in a terminal, with a progress bar.
 *
 *   mercury upgrade            update to the newest version (waits for running work)
 *   mercury upgrade --now      don't wait for running work
 *   mercury upgrade --check    just say what's new
 *   mercury upgrade --force    reinstall even when already on the newest version
 *   mercury update [check]     what's new / is an update required
 *
 * With Mercury running, the running Mercury does it (so it can wait for
 * running work and come back as the new version). With it stopped, this
 * process does every step itself and leaves it stopped.
 */

const base = () => `http://127.0.0.1:${getWebPort()}`;

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T } | null> {
  const token = readAttachToken();
  if (!token) return null;
  try {
    const res = await fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json().catch(() => ({})) as T };
  } catch {
    return null;
  }
}

function bar(percent: number | null, width = 24): string {
  if (percent === null) return chalk.dim('·'.repeat(width));
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
}

function mb(n?: number): string { return n ? `${(n / 1024 / 1024).toFixed(1)} MB` : ''; }

let lastLine = '';
function render(job: UpdateJob): void {
  const size = job.state === 'downloading' && job.bytes ? chalk.dim(` ${mb(job.bytes)}${job.total ? ` / ${mb(job.total)}` : ''}`) : '';
  const line = `  ${bar(job.percent)} ${String(job.percent ?? 0).padStart(3)}%  ${job.message}${size}`;
  if (line === lastLine) return;
  lastLine = line;
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
  else console.log(line);
}

function endLine(): void { if (process.stdout.isTTY && lastLine) process.stdout.write('\n'); lastLine = ''; }

function printOutcome(job: UpdateJob): void {
  endLine();
  const colour = job.state === 'done' ? chalk.green('  ✓ ') : job.state === 'rolled-back' ? chalk.yellow('  ↺ ') : job.state === 'cancelled' ? chalk.dim('  · ') : chalk.red('  ✗ ');
  console.log(colour + job.message);
  if (job.state !== 'done' && job.state !== 'cancelled' && job.error && !job.message.includes(job.error)) console.log(chalk.dim(`    ${job.error}`));
  if (job.state === 'failed' || job.state === 'rolled-back') console.log(chalk.dim('    Details: ~/.mercury/updates/job.json and worker.log'));
  console.log('');
}

/** "What's new" and whether an update is due. */
export function printStatus(s: ServerUpdateStatus): void {
  console.log(chalk.cyan(`  Mercury ${chalk.white(`v${s.current}`)}`) + chalk.dim(` · ${s.install}${s.channel === 'dev' ? ' · dev channel' : ''}`));
  if (s.required) {
    console.log(chalk.red(`  ⚠ Update required${s.required.severity === 'security' ? ' (security)' : ''}: ${s.required.reason}`));
    console.log(chalk.red(`    Versions below ${s.required.version} must update. Run: mercury upgrade`));
  }
  if (!s.latest) console.log(chalk.dim('  Couldn\'t check for updates (offline?).'));
  else if (!s.updateAvailable) console.log(chalk.green(`  ✓ This is the newest ${s.channel === 'dev' ? 'dev build' : 'version'}.`));
  else {
    console.log(chalk.yellow(`  ⬆ Mercury ${s.latest.version} is available${s.latest.date ? chalk.dim(` (${s.latest.date})`) : ''}.`));
    if (s.latest.downloadable === false) console.log(chalk.dim('    It isn\'t downloadable yet; try again later.'));
    if (s.blocked) console.log(chalk.dim(`    It failed to install ${s.blocked.failures} times (${s.blocked.lastError}). \`mercury upgrade\` tries again.`));
    if (s.latest.notes) {
      console.log('');
      for (const l of s.latest.notes.split('\n').slice(0, 30)) console.log(`    ${l}`);
      if (s.latest.notes.split('\n').length > 30) console.log(chalk.dim('    …'));
    }
    if (s.latest.notesUrl) console.log(chalk.dim(`    ${s.latest.notesUrl}`));
    if (s.canSelfUpdate) console.log(`\n  Update with: ${chalk.white('mercury upgrade')}`);
    else console.log(chalk.dim(`\n  ${s.cannotReason}`));
  }
  for (const m of s.messages) console.log(`\n  ${m.level === 'critical' ? chalk.red('!') : m.level === 'warning' ? chalk.yellow('!') : chalk.cyan('i')} ${chalk.bold(m.title)}${m.body ? `\n    ${m.body.split('\n').join('\n    ')}` : ''}${m.link ? chalk.dim(`\n    ${m.link.url}`) : ''}`);
  console.log('');
}

/** Through the running Mercury. Null when it isn't running or predates the update API. */
async function updateViaRunning(to: string, now: boolean): Promise<UpdateJob | null> {
  const health = await api<{ features?: string[] }>('/api/health');
  if (!health || !health.body.features?.includes('updates')) return null;
  const started = await api<{ job?: UpdateJob; error?: string }>('/api/updates/server', { method: 'POST', body: JSON.stringify({ version: to, now }) });
  if (!started) return null;
  if (started.status !== 202 || !started.body.job) {
    console.log(chalk.red(`  ✗ ${started.body.error ?? `The update could not start (HTTP ${started.status}).`}`));
    if (started.body.job) console.log(chalk.dim(`    ${started.body.job.message}`));
    console.log('');
    return started.body.job ?? ({ state: 'failed' } as UpdateJob);
  }
  let job = started.body.job;
  const id = job.id;
  render(job);
  // Mercury is down for a few seconds in between: the job file says how it's going.
  const until = Date.now() + 20 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 600));
    const disk = readJob();
    if (disk && disk.id === id) job = disk;
    render(job);
    if (TERMINAL.has(job.state)) break;
  }
  printOutcome(job);
  return job;
}

/** Every step in this process. Mercury wasn't running, so it isn't started; the new version is checked with `--version`. */
async function updateHere(to: string, install: InstallInfo): Promise<UpdateJob> {
  const { getDaemonStatus, getForegroundRuntimeStatus } = await import('./daemon.js');
  const wasRunning = getDaemonStatus().running || getForegroundRuntimeStatus().running;
  const steps: WorkerSteps = wasRunning || process.env.MERCURY_UPDATE_DRY_RUN === '1'
    ? realWorkerSteps()
    : { ...realWorkerSteps(), start: async () => {}, health: async (version) => installedVersion(install) === version };
  const started = startServerUpdate({
    current: currentVersion,
    to, install, now: true, manual: true,
    steps: { handOver: async (job) => { void runUpdateWorker(job.id, steps, wasRunning ? HEALTH_TIMEOUT_MS : 30_000); return process.pid; } },
  });
  if (!started.ok) {
    console.log(chalk.red(`  ✗ ${started.error}`));
    console.log('');
    return started.job ?? ({ state: 'failed' } as UpdateJob);
  }
  const id = started.job.id;
  let job = started.job;
  await started.done;
  for (;;) {
    const disk = readJob();
    if (disk && disk.id === id) job = disk;
    render(job);
    if (TERMINAL.has(job.state)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  printOutcome(job);
  return job;
}

let currentVersion = '';

function installedVersion(install: InstallInfo): string {
  try {
    const out = install.kind === 'binary' && install.binaryPath
      ? execFileSync(install.binaryPath, ['--version'], { encoding: 'utf-8', timeout: 30_000 })
      : execFileSync(process.execPath, [process.argv[1], '--version'], { encoding: 'utf-8', timeout: 30_000 });
    return out.trim().split(/\s+/).pop() ?? '';
  } catch {
    return '';
  }
}

export interface UpgradeOptions { force?: boolean; check?: boolean; now?: boolean }

export async function runUpgrade(version: string, opts: UpgradeOptions, legacyReinstall: () => Promise<void>): Promise<void> {
  currentVersion = version;
  console.log('');
  const status = await serverUpdateStatus({ current: version, force: true });
  if (opts.check) { printStatus(status); return; }

  console.log(chalk.cyan(`  Mercury ${chalk.white(`v${version}`)}`));
  const install = detectInstall(version);
  if (!install.canSelfUpdate) {
    console.log(chalk.yellow(`  ${install.cannotReason}`));
    console.log('');
    return;
  }
  const to = targetVersion(status);
  if (!to) {
    if (opts.force) { await legacyReinstall(); return; }
    if (!status.latest) console.log(chalk.yellow('  Couldn\'t reach the update server. Try again later, or use --force to reinstall.'));
    else console.log(chalk.green(`  ✓ Already on the newest ${status.channel === 'dev' ? 'dev build' : 'version'} (v${version}). Nothing to do.`));
    console.log(chalk.dim('  Use mercury upgrade --force to reinstall anyway.'));
    console.log('');
    return;
  }
  console.log(chalk.dim(`  Updating to v${to}${status.channel === 'dev' ? ' (dev channel)' : ''}. Mercury goes back on its own if the new version doesn't start.`));
  console.log('');
  const job = (await updateViaRunning(to, !!opts.now)) ?? (await updateHere(to, install));
  if (job.state === 'done' && status.latest?.notesUrl) console.log(chalk.dim(`  What's new: ${status.latest.notesUrl}\n`));
  if (job.state !== 'done' && job.state !== 'cancelled') process.exitCode = 1;
}

export function registerUpdateCli(program: Command, version: string): void {
  program
    .command('update [what]')
    .description('Is there a newer Mercury, and what\'s in it (`mercury update check` asks again now)')
    .action(async (what?: string) => {
      console.log('');
      printStatus(await serverUpdateStatus({ current: version, force: what === 'check' }));
    });

  // The detached half of an update: stop, install, start, check, or go back.
  program
    .command('__update-worker <jobId>', { hidden: true })
    .action(async (jobId: string) => {
      const job = await runUpdateWorker(jobId);
      process.exit(job && job.state === 'done' ? 0 : 1);
    });
}
