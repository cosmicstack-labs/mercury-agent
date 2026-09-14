import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import readline from 'node:readline';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isStandaloneBinary, getDaemonStatus, getForegroundRuntimeStatus, stopDaemon, stopForegroundRuntime } from './daemon.js';
import { teardownService } from './service.js';

/**
 * Full, clean uninstall — `mercury uninstall`.
 *
 * Channel- and platform-aware teardown: stops the running runtimes, removes
 * the system service (launchd / systemd / schtasks), then removes the
 * DISTRIBUTION ARTIFACTS for every channel present:
 *
 *   - npm:        global (`npm uninstall -g`) and/or local (`npm uninstall`
 *                 in the owning project), including stale copies across
 *                 nvm-managed node versions
 *   - standalone: the binary + web assets under ~/.mercury/bin, plus the
 *                 installer's PATH line in shell rc files (Windows: the
 *                 User PATH entry)
 *   - service:    plist / unit / scheduled task (teardownService)
 *
 * Data (~/.mercury: memory, sessions, soul, keys, projects) is PRESERVED by
 * default — `--purge-data` (or a confirmed prompt) wipes it too. Windows
 * cannot delete the running executable, so file removal is scheduled through
 * a detached PowerShell job after this process exits; on POSIX the final data
 * removal is also detached, so lazy imports can never hit deleted files
 * mid-run.
 */

const NPM_PACKAGE = '@cosmicstack/mercury-agent';
export const REPO_ISSUES_URL = 'https://github.com/cosmicstack-labs/mercury-agent/issues';
export const FEEDBACK_EMAIL = 'mercury@cosmicstack.org';

/** The shell rc files the standalone installer may have touched (same best-effort set as install.sh). */
export function shellRcFiles(): string[] {
  const home = homedir();
  const candidates = [
    join(home, '.zshrc'),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.profile'),
    join(home, '.config', 'fish', 'config.fish'),
  ];
  return candidates.filter((rc) => existsSync(rc));
}

/**
 * Remove the installer's PATH lines from an rc file's content: the marker
 * line and any PATH line that references the bin dir. Returns null when
 * nothing matched (no rewrite needed).
 */
export function stripInstallerPathLines(content: string, binDir: string): string | null {
  const lines = content.split('\n');
  const mentionsBinDir = (line: string): boolean => {
    let at = line.indexOf(binDir);
    while (at >= 0) {
      const next = line[at + binDir.length];
      // Whole-path match only: a directory merely PREFIXED by the bin dir
      // (e.g. "…mercury/bin-backup") must survive the strip.
      if (next === undefined || !/[A-Za-z0-9_.\-/\\]/.test(next)) return true;
      at = line.indexOf(binDir, at + 1);
    }
    return false;
  };
  const kept = lines.filter((line) => {
    if (line.includes('# added by mercury installer')) return false;
    if (/PATH/.test(line) && mentionsBinDir(line)) return false;
    return true;
  });
  if (kept.length === lines.length) return null;
  return kept.join('\n');
}

function run(cmd: string): boolean {
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Global npm roots that may hold @cosmicstack/mercury-agent (active node + all nvm-managed versions). */
export function npmGlobalRoots(): string[] {
  const roots = new Set<string>();
  try {
    const active = execSync('npm root -g', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (active) roots.add(active);
  } catch {}
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    try {
      for (const version of readdirSync(nvmDir)) {
        roots.add(join(nvmDir, version, 'lib', 'node_modules'));
      }
    } catch {}
  }
  return [...roots];
}

/**
 * npm installs of the package: global roots and the running local project.
 * `roots` / `entryScript` are injectable so the discovery logic is testable
 * on machines with no real install (fresh CI runners) — production always
 * calls it with no arguments.
 */
export function findNpmInstalls(opts: { roots?: string[]; entryScript?: string } = {}): { global: string[]; local: string[] } {
  const global: string[] = [];
  const local: string[] = [];
  for (const root of opts.roots ?? npmGlobalRoots()) {
    const pkg = join(root, '@cosmicstack', 'mercury-agent');
    if (existsSync(pkg)) global.push(pkg);
  }
  // Local install: the running entry script lives inside a project's node_modules.
  const script = opts.entryScript ?? process.argv[1] ?? '';
  const marker = `${sep}node_modules${sep}@cosmicstack${sep}mercury-agent${sep}`;
  const index = script.lastIndexOf(marker);
  if (index >= 0 && !global.some((g) => script.startsWith(dirname(g) + sep))) {
    // The marker starts AT "/node_modules", so the slice ends at the project
    // dir itself — no extra dirname (that stripped the project, leaving
    // local detection always empty).
    const project = script.slice(0, index); // .../project
    if (existsSync(join(project, 'package.json'))) {
      local.push(join(project, 'node_modules', '@cosmicstack', 'mercury-agent'));
    }
  }
  return { global, local };
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Detached post-exit cleanup for paths the running process must not delete while alive. */
function schedulePostExitRemoval(paths: string[]): void {
  if (paths.length === 0) return;
  if (process.platform === 'win32') {
    const psPaths = paths.map((p) => `"${p}"`).join(', ');
    const ps = `Start-Sleep -Seconds 2; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${psPaths}`;
    try {
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      logger.warn({ err }, 'uninstall: failed to schedule Windows post-exit cleanup');
    }
  } else {
    const sh = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
    try {
      spawn('sh', ['-c', `sleep 2; rm -rf ${sh}`], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      logger.warn({ err }, 'uninstall: failed to schedule post-exit cleanup');
    }
  }
}

export interface UninstallOptions {
  /** true = purge ~/.mercury data too; false = keep; undefined = ask. */
  purgeData?: boolean;
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const home = getMercuryHome();
  const binDir = join(home, 'bin');
  const standalone = isStandaloneBinary();
  const removed: string[] = [];
  const kept: string[] = [];
  const manual: string[] = [];

  console.log('');
  console.log(chalk.bold.white('  ☿ Mercury Uninstaller'));
  console.log(chalk.dim(`  Home: ${home}`));
  console.log(chalk.dim(`  Channel: ${standalone ? 'standalone binary' : 'npm package'}`));
  console.log('');

  // Data decision BEFORE anything is torn down.
  let purge = opts.purgeData ?? false;
  if (opts.purgeData === undefined) {
    purge = await confirm(chalk.white(`  Also remove all Mercury data (${home} — memory, sessions, soul, keys)? [y/N]: `));
    console.log('');
  }
  if (purge) console.log(chalk.yellow('  Data will be removed: ~/.mercury in its entirety.'));
  else console.log(chalk.dim('  Your data (~/.mercury) is kept — only the runtime artifacts are removed.'));

  // 1. Stop runtimes: foreground TUI and background daemon.
  const foreground = getForegroundRuntimeStatus();
  if (foreground.running) {
    console.log(chalk.dim(`  Stopping foreground runtime (PID ${foreground.pid})...`));
    if (await stopForegroundRuntime()) removed.push('foreground runtime');
    else manual.push('Foreground runtime did not stop — kill it manually: kill <pid>');
  }
  const daemon = getDaemonStatus();
  if (daemon.running) {
    console.log(chalk.dim('  Stopping background daemon...'));
    if (await stopDaemon()) removed.push('background daemon');
    else manual.push('Daemon did not stop — run: mercury stop');
  }

  // 2. System service (launchd / systemd / schtasks).
  console.log(chalk.dim('  Removing system service...'));
  const service = teardownService();
  if (service.removed) removed.push(`system service (${service.path})`);
  else if (service.hint) manual.push(service.hint);
  else console.log(chalk.dim('    not installed'));

  // 3. npm channel: global and local installs (global is always attempted — a
  // stale install under another node version may exist even if the scan missed it).
  const npm = findNpmInstalls();
  if (npm.global.length > 0) {
    for (const pkg of npm.global) {
      console.log(chalk.dim(`  Removing global npm install: ${pkg}`));
      run(`npm uninstall -g ${NPM_PACKAGE}`);
      if (existsSync(pkg)) manual.push(`Remove manually: npm uninstall -g ${NPM_PACKAGE} (still present: ${pkg})`);
      else removed.push('global npm install');
    }
  } else {
    console.log(chalk.dim('  Trying global npm uninstall (no-op if not installed)...'));
    run(`npm uninstall -g ${NPM_PACKAGE}`);
  }
  for (const pkg of npm.local) {
    const project = dirname(dirname(dirname(pkg))); // pkg → @cosmicstack → node_modules → project
    console.log(chalk.dim(`  Removing local npm install (project: ${project})...`));
    run(`npm uninstall ${NPM_PACKAGE}`);
    if (existsSync(pkg)) manual.push(`Remove manually: cd ${project} && npm uninstall ${NPM_PACKAGE}`);
    else removed.push('local npm install');
  }

  // 4. Standalone artifacts: binary + web assets (kept-data mode) and PATH entries.
  if (existsSync(binDir)) {
    console.log(chalk.dim(`  Removing binary and web assets: ${binDir}`));
    if (process.platform === 'win32' && standalone) {
      // Windows locks the running executable — remove after this process exits.
      schedulePostExitRemoval([binDir]);
      removed.push('binary + web assets (after exit)');
    } else {
      try {
        rmSync(binDir, { recursive: true, force: true });
        removed.push('binary + web assets');
      } catch (err: any) {
        manual.push(`Remove manually: rm -rf ${binDir} (${err?.message ?? err})`);
      }
    }
  }
  for (const rc of shellRcFiles()) {
    const content = readFileSync(rc, 'utf-8');
    const stripped = stripInstallerPathLines(content, binDir);
    if (stripped != null) {
      try {
        writeFileSync(rc, stripped, 'utf-8');
        removed.push(`PATH line in ${rc}`);
      } catch {
        manual.push(`Remove the mercury PATH line from ${rc}`);
      }
    }
  }
  if (process.platform === 'win32') {
    console.log(chalk.dim('  Cleaning Windows user PATH...'));
    const bin = binDir.replace(/\\/g, '\\\\');
    const ps = `$bin='${bin}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $n=($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $bin.TrimEnd('\\')) }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User')`;
    if (run(`powershell.exe -NoProfile -Command "${ps}"`)) removed.push('Windows user PATH entry');
    else manual.push(`Remove ${binDir} from your user PATH (System Properties → Environment Variables)`);
  }

  // 5. Data purge LAST, detached: the removal happens after this process exits,
  // so nothing lazy-imported mid-run can ever hit a deleted file.
  if (purge && existsSync(home)) {
    console.log(chalk.dim(`  Removing all Mercury data: ${home}...`));
    schedulePostExitRemoval([home]);
    removed.push('Mercury data (after exit)');
  } else {
    kept.push(`${home} (memory, sessions, soul, keys)`);
  }

  // 6. Summary + support links.
  console.log('');
  console.log(chalk.bold.white('  Uninstall complete.'));
  for (const item of removed) console.log(chalk.green(`    ✓ removed ${item}`));
  for (const item of kept) console.log(chalk.dim(`    kept ${item}`));
  for (const item of manual) console.log(chalk.yellow(`    ! ${item}`));
  console.log('');
  console.log(`  Issues:      ${chalk.cyan(REPO_ISSUES_URL)}`);
  console.log(`  Feedback:    ${chalk.cyan(FEEDBACK_EMAIL)}`);
  console.log('');
}