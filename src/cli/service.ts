import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isStandaloneBinary, getDaemonStatus, tryAutoDaemonize } from './daemon.js';
import { isTermux } from '../utils/platform.js';

const SERVICE_DESC = 'Mercury — Soul-Driven AI Agent';
export const WIN_TASK_NAME = 'MercuryAgent';
/** Per-user autostart key — writable without elevation. */
export const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WIN_RUN_VALUE = 'MercuryAgent';
const WIN_TASK_XML_FILE = 'MercuryAgent.task.xml';

/**
 * How Mercury autostarts on Windows:
 *   - `task`: a Task Scheduler logon task (`schtasks /create /xml`) — the
 *     preferred form: Task Scheduler tracks the daemon process, restarts it
 *     on failure, and `schtasks /end` stops it.
 *   - `run-key`: an `HKCU\...\Run` entry. Fallback for standard (non-admin)
 *     users, for whom logon-triggered tasks are refused with "Access is
 *     denied". No restart-on-failure; the entry launches `mercury start`,
 *     which spawns the hidden daemon and exits.
 */
export type WindowsServiceMode = 'task' | 'run-key';

export function isServiceInstalled(): boolean {
  const platform = process.platform;

  if (isTermux()) return false;

  if (platform === 'darwin') {
    return existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist'));
  } else if (platform === 'linux') {
    return existsSync(join(homedir(), '.config', 'systemd', 'user', 'mercury.service'));
  } else if (platform === 'win32') {
    return getWindowsServiceMode() !== null;
  }
  return false;
}

export function isServiceRunning(): boolean {
  if (!isServiceInstalled()) return false;
  try {
    if (process.platform === 'darwin') {
      const target = `gui/${process.getuid?.() ?? 0}/com.cosmicstack.mercury`;
      const output = execSync(`launchctl print ${target}`, { encoding: 'utf-8' });
      return /state\s*=\s*running/.test(output);
    }
    if (process.platform === 'linux') {
      execSync('systemctl --user is-active --quiet mercury.service', { stdio: 'pipe' });
      return true;
    }
    if (process.platform === 'win32') {
      if (getWindowsServiceMode() === 'run-key') {
        // The Run entry only launches the daemon; its liveness is the pid file.
        return getDaemonStatus().running;
      }
      const output = execSync(`schtasks /query /tn "${WIN_TASK_NAME}" /fo list /v`, { encoding: 'utf-8', shell: 'cmd.exe' });
      return /^Status:\s+Running\s*$/im.test(output);
    }
  } catch {}
  return false;
}

function getNodeBinPath(): string {
  return process.execPath;
}

/**
 * Resolve the on-disk `dist/index.js` a service file should launch.
 *
 * `argv[1]` is the entry script as invoked: on POSIX npm installs that is the
 * `bin/mercury` symlink (→ `lib/node_modules/@cosmicstack/mercury-agent/dist/
 * index.js`), on Windows npm installs the `.cmd` shim already hands node the
 * real `%APPDATA%\npm\node_modules\...\dist\index.js`. `realpathSync` folds
 * both into the real file, so no layout assumption (`bin/../lib/...`) is
 * needed. Fallbacks: this module's own location (the bundle IS dist/index.js),
 * then the legacy nvm guess.
 */
export function resolveDistPath(
  argv1: string | undefined,
  moduleUrl: string = import.meta.url,
  nodeVersion: string = process.version,
): string {
  if (argv1) {
    try {
      return realpathSync(argv1);
    } catch {
      // argv[1] is not a real file (bun-virtual path, deleted shim) — fall through.
    }
  }
  try {
    const self = fileURLToPath(moduleUrl);
    if (/[\\/]dist[\\/]index\.(?:m?js|cjs)$/i.test(self) && existsSync(self)) return self;
  } catch {
    // not a file: URL (unusual bundler) — fall through.
  }
  return join(homedir(), '.nvm', 'versions', 'node', `v${nodeVersion.replace(/^v/, '')}`, 'lib', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist', 'index.js');
}

function getDistPath(): string {
  return resolveDistPath(process.argv[1]);
}

/**
 * Returns the argv pieces a system-service file should use to launch Mercury
 * as a daemon. For npm installs this is `node <dist/index.js> start --daemon`;
 * for standalone (bun --compile) binaries it is just `<mercury> start --daemon`
 * because `process.argv[1]` is a bun-virtual path that must not be persisted.
 */
function getServiceLaunchArgs(): string[] {
  if (isStandaloneBinary()) {
    return [process.execPath, 'start', '--daemon'];
  }
  return [getNodeBinPath(), getDistPath(), 'start', '--daemon'];
}

/**
 * Install the login/boot service. Returns whether a system service now
 * exists. Never calls `process.exit`: this runs inside the setup wizard and
 * `mercury up` (`autoDaemonize`), where a hard exit aborts the flow before
 * the daemon is even started. Termux (no systemd; `process.platform` is
 * `'android'` on real devices) and other unsupported platforms print a hint
 * and return false so the caller can still daemonize for this session.
 */
export function installService(): boolean {
  const platform = process.platform;

  if (isTermux()) {
    showTermuxServiceHelp('install');
    return false;
  }

  if (platform === 'darwin') {
    installMac();
  } else if (platform === 'linux') {
    installLinux();
  } else if (platform === 'win32') {
    return installWindows() !== null;
  } else {
    console.log(chalk.yellow(`  System service is not supported on this platform (${platform}).`));
    console.log(chalk.dim('  Run `mercury up` manually to start the daemon for this session.'));
    return false;
  }
  return true;
}

export function uninstallService(): boolean {
  const platform = process.platform;

  if (isTermux()) {
    showTermuxServiceHelp('uninstall');
    return false;
  }

  if (platform === 'darwin') {
    uninstallMac();
  } else if (platform === 'linux') {
    uninstallLinux();
  } else if (platform === 'win32') {
    uninstallWindows();
  } else {
    console.log(chalk.yellow(`  System service is not supported on this platform (${platform}) — nothing to uninstall.`));
    return false;
  }
  return true;
}

/**
 * Non-exiting service teardown for the full `mercury uninstall` flow. Returns
 * what happened instead of printing/exiting, so the uninstaller can fold it
 * into its own summary. `removed` false with no hint means "was not installed".
 */
export function teardownService(): { removed: boolean; path?: string; hint?: string } {
  const platform = process.platform;

  if (isTermux()) return { removed: false, hint: 'Termux: no system service — nothing to remove' };

  if (platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist');
    if (!existsSync(plistPath)) return { removed: false };
    try { execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' }); } catch {}
    try {
      unlinkSync(plistPath);
      return { removed: true, path: plistPath };
    } catch {
      return { removed: false, hint: `Remove manually: rm ${plistPath}` };
    }
  }

  if (platform === 'linux') {
    const servicePath = join(homedir(), '.config', 'systemd', 'user', 'mercury.service');
    if (!existsSync(servicePath)) return { removed: false };
    try {
      execSync('systemctl --user stop mercury.service', { stdio: 'pipe' });
      execSync('systemctl --user disable mercury.service', { stdio: 'pipe' });
    } catch {}
    try {
      unlinkSync(servicePath);
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
      return { removed: true, path: servicePath };
    } catch {
      return { removed: false, hint: `Remove manually: rm ${servicePath}` };
    }
  }

  if (platform === 'win32') {
    const removed = removeWindowsAutostart();
    if (removed.length === 0) return { removed: false };
    return { removed: true, path: removed.join(' + ') };
  }

  return { removed: false, hint: `Unsupported platform for service teardown: ${platform}` };
}

export function showServiceStatus(): void {
  const platform = process.platform;

  if (isTermux()) {
    showTermuxServiceHelp('status');
    return;
  }

  if (platform === 'darwin') {
    showMacStatus();
  } else if (platform === 'linux') {
    showLinuxStatus();
  } else if (platform === 'win32') {
    showWindowsStatus();
  }
}

export function restartService(): void {
  if (!isServiceInstalled()) throw new Error('Mercury system service is not installed');

  if (process.platform === 'darwin') {
    const target = `gui/${process.getuid?.() ?? 0}/com.cosmicstack.mercury`;
    try {
      execSync(`launchctl kickstart -k ${target}`, { stdio: 'inherit' });
    } catch {
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist');
      execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
      execSync(`launchctl kickstart -k ${target}`, { stdio: 'inherit' });
    }
    return;
  }

  if (process.platform === 'linux') {
    execSync('systemctl --user restart mercury.service', { stdio: 'inherit' });
    return;
  }

  if (process.platform === 'win32') {
    if (getWindowsServiceMode() === 'run-key') {
      // No scheduler owns the process: stop the tracked daemon, respawn it.
      stopTrackedDaemonSync();
      if (!tryAutoDaemonize()) throw new Error('Failed to respawn the Mercury daemon');
      return;
    }
    try {
      execSync(`schtasks /end /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe', shell: 'cmd.exe' });
    } catch {}
    execSync(`schtasks /run /tn "${WIN_TASK_NAME}"`, { stdio: 'inherit', shell: 'cmd.exe' });
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function stopService(): boolean {
  if (!isServiceInstalled()) return true;

  if (process.platform === 'darwin') {
    const target = `gui/${process.getuid?.() ?? 0}/com.cosmicstack.mercury`;
    try { execSync(`launchctl kill SIGTERM ${target}`, { stdio: 'inherit' }); } catch {}
    return waitForServiceStop();
  }
  if (process.platform === 'linux') {
    execSync('systemctl --user stop mercury.service', { stdio: 'inherit' });
    return !isServiceRunning();
  }
  if (process.platform === 'win32') {
    if (getWindowsServiceMode() === 'run-key') {
      stopTrackedDaemonSync();
      return !isServiceRunning();
    }
    try { execSync(`schtasks /end /tn "${WIN_TASK_NAME}"`, { stdio: 'inherit', shell: 'cmd.exe' }); } catch {}
    return waitForServiceStop();
  }
  return true;
}

function waitForServiceStop(): boolean {
  const deadline = Date.now() + 5_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isServiceRunning()) return true;
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
  return !isServiceRunning();
}

/**
 * Synchronous stop of the pid-file daemon (Windows run-key mode only). The
 * async, graceful path is `stopDaemon()` in daemon.ts — callers that can
 * await should use that; this is the sync fallback for `stopService()`.
 */
function stopTrackedDaemonSync(): void {
  const status = getDaemonStatus();
  if (!status.running || !status.pid) return;
  try { process.kill(status.pid); } catch { return; }
  const deadline = Date.now() + 5_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && getDaemonStatus().running) {
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
}

function showTermuxServiceHelp(action: 'install' | 'uninstall' | 'status'): void {
  console.log('');
  console.log(chalk.yellow(`  System service ${action} is not supported on Termux yet (no systemd on Android).`));
  console.log(chalk.dim('  Start Mercury manually with: mercury up   (or: mercury start)'));
  console.log(chalk.dim('  Check it with:               mercury status'));
  console.log(chalk.dim('  Stop it with:                mercury stop'));
  console.log(chalk.dim('  For boot startup, install the Termux:Boot add-on and put `mercury up` in ~/.termux/boot/mercury.sh.'));
  console.log('');
}

// ─── Service file builders (pure; unit-tested) ───────────────────────────────

export interface ServiceFileOptions {
  /** Where daemon stdout/stderr go (`~/.mercury`). */
  mercuryHome: string;
  /** Account home — WorkingDirectory and HOME for the daemon. */
  userHome: string;
  /** PATH the daemon inherits. */
  pathEnv: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** macOS LaunchAgent plist for the given launch argv. */
export function buildLaunchAgentPlist(launchArgs: string[], opts: ServiceFileOptions): string {
  // plist and systemd files are POSIX formats regardless of the host that
  // renders them (CI runs these builders on Windows too), so use posix joins.
  const logPath = posix.join(opts.mercuryHome, 'daemon.log');
  const errPath = posix.join(opts.mercuryHome, 'daemon-error.log');
  const programArgsXml = launchArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cosmicstack.mercury</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(opts.pathEnv)}</string>
    <key>HOME</key>
    <string>${xmlEscape(opts.userHome)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.userHome)}</string>
</dict>
</plist>`;
}

/** Quote one ExecStart= word per systemd.service(5) (double quotes, `\"` inside). */
function quoteSystemdWord(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** systemd --user unit for the given launch argv. */
export function buildSystemdUnit(launchArgs: string[], opts: ServiceFileOptions): string {
  const execStart = launchArgs.map(quoteSystemdWord).join(' ');
  return `[Unit]
Description=${SERVICE_DESC}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
Environment=PATH=${opts.pathEnv}
Environment=HOME=${opts.userHome}
WorkingDirectory=${opts.userHome}
StandardOutput=append:${posix.join(opts.mercuryHome, 'daemon.log')}
StandardError=append:${posix.join(opts.mercuryHome, 'daemon-error.log')}

[Install]
WantedBy=default.target`;
}

/**
 * Quote one argv word for a Windows command line (CreateProcess rules as
 * read by node.exe / the CRT): wrap in double quotes when it has whitespace
 * or quotes, escape embedded quotes as `\"`.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** A full Windows command line for the launch argv (what the daemon is started with). */
export function buildWindowsCommandLine(launchArgs: string[]): string {
  return launchArgs.map(quoteWindowsArg).join(' ');
}

/**
 * `schtasks /create ... /tr "<command line>"` for cmd.exe. The `/tr` payload
 * is itself a quoted cmd.exe argument, so the launch command line's own
 * quotes must be escaped as `\"` inside it — otherwise a `node.exe` under
 * `C:\Program Files` splits the task into `C:\Program` + garbage.
 * Kept as the manual-fallback hint; the install path uses the XML form.
 */
export function buildSchtasksCreateCommand(launchArgs: string[], taskName: string = WIN_TASK_NAME): string {
  const tr = buildWindowsCommandLine(launchArgs).replace(/"/g, '\\"');
  return `schtasks /create /tn "${taskName}" /tr "${tr}" /sc onlogon /rl limited /f`;
}

export interface WindowsTaskOptions {
  /** WorkingDirectory for the daemon (account home). */
  workingDirectory: string;
  /** `DOMAIN\user` the logon trigger is scoped to; omitted → any user logon. */
  userId?: string;
  description?: string;
}

/**
 * Task Scheduler task definition for `schtasks /create /xml`. Command and
 * Arguments are separate XML elements, so the quoting trap of `/tr` cannot
 * recur, and the XML form is the only way to set what `/sc onlogon` cannot:
 *   - RestartOnFailure (3 tries, 1 min apart) — crash recovery;
 *   - ExecutionTimeLimit PT0S — the `/create` default (PT72H) would kill the
 *     daemon after three days;
 *   - MultipleInstancesPolicy IgnoreNew — one daemon per user.
 * Runs with the interactive token at least privilege (no elevation prompt).
 */
export function buildWindowsTaskXml(launchArgs: string[], opts: WindowsTaskOptions): string {
  const [command, ...rest] = launchArgs;
  const userIdXml = opts.userId ? `\n      <UserId>${xmlEscape(opts.userId)}</UserId>` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(opts.description ?? SERVICE_DESC)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${userIdXml}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(buildWindowsCommandLine(rest))}</Arguments>
      <WorkingDirectory>${xmlEscape(opts.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/** `schtasks /create /xml` must read UTF-16LE with a BOM. */
export function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.from(`\uFEFF${xml}`, 'utf16le');
}

/**
 * `reg add` for the per-user Run key (no elevation). The `/d` payload is a
 * quoted cmd.exe argument; reg.exe reads `\"` as a literal quote.
 */
export function buildRunKeyAddCommand(launchArgs: string[]): string {
  const data = buildWindowsCommandLine(launchArgs).replace(/"/g, '\\"');
  return `reg add "${WIN_RUN_KEY}" /v ${WIN_RUN_VALUE} /t REG_SZ /d "${data}" /f`;
}

export function buildRunKeyDeleteCommand(): string {
  return `reg delete "${WIN_RUN_KEY}" /v ${WIN_RUN_VALUE} /f`;
}

/**
 * Launch argv for the Run-key fallback: `mercury start` (no `--daemon`)
 * spawns the hidden, detached daemon and exits, so the login console window
 * only flashes instead of staying open for the daemon's lifetime. A direct
 * `--daemon` launch (what the scheduled task uses, so Task Scheduler owns the
 * process) would leave a visible console at every logon.
 */
export function runKeyLaunchArgs(serviceLaunchArgs: string[]): string[] {
  return serviceLaunchArgs.filter((a) => a !== '--daemon');
}

// ─── macOS ───────────────────────────────────────────────────────────────────

function serviceFileOptions(): ServiceFileOptions {
  return {
    mercuryHome: getMercuryHome(),
    userHome: homedir(),
    pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
}

function installMac(): void {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, 'com.cosmicstack.mercury.plist');

  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true });
  }

  const opts = serviceFileOptions();
  const logPath = join(opts.mercuryHome, 'daemon.log');
  const plist = buildLaunchAgentPlist(getServiceLaunchArgs(), opts);

  writeFileSync(plistPath, plist, 'utf-8');

  try {
    execSync(`launchctl load ${plistPath}`, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow('  launchctl load failed. Try running:'));
    console.log(chalk.dim(`    launchctl load ${plistPath}`));
  }

  console.log('');
  console.log(chalk.green('  Mercury service installed (macOS LaunchAgent)'));
  console.log(chalk.dim(`  Plist: ${plistPath}`));
  console.log(chalk.dim(`  Logs: ${logPath}`));
  console.log(chalk.dim('  Auto-starts on login. Auto-restarts on crash.'));
  console.log('');
  console.log(chalk.dim('  Uninstall: mercury service uninstall'));
  console.log('');
}

function uninstallMac(): void {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist');

  if (!existsSync(plistPath)) {
    console.log(chalk.yellow('  Mercury service is not installed.'));
    console.log('');
    process.exit(0);
  }

  try {
    execSync(`launchctl unload ${plistPath}`, { stdio: 'inherit' });
  } catch {
    // may already be unloaded
  }

  try {
    unlinkSync(plistPath);
  } catch {
    console.log(chalk.yellow('  Failed to remove plist file. Remove manually:'));
    console.log(chalk.dim(`    rm ${plistPath}`));
  }

  console.log('');
  console.log(chalk.green('  Mercury service uninstalled'));
  console.log('');
}

function showMacStatus(): void {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist');

  if (!existsSync(plistPath)) {
    console.log(chalk.yellow('  Mercury service is not installed.'));
    console.log(chalk.dim('  Run `mercury service install` to set it up.'));
    console.log('');
    return;
  }

  try {
    const output = execSync('launchctl list | grep com.cosmicstack.mercury', { encoding: 'utf-8' }).trim();
    console.log(`  ${chalk.green('Service installed and loaded')}`);
    console.log(chalk.dim(`  ${output}`));
  } catch {
    console.log(`  ${chalk.yellow('Service installed but not loaded')}`);
    console.log(chalk.dim(`  Plist: ${plistPath}`));
  }
  console.log('');
}

// ─── Linux ───────────────────────────────────────────────────────────────────

function installLinux(): void {
  const systemdDir = join(homedir(), '.config', 'systemd', 'user');

  if (!existsSync(systemdDir)) {
    mkdirSync(systemdDir, { recursive: true });
  }

  const servicePath = join(systemdDir, 'mercury.service');
  const opts = serviceFileOptions();
  const service = buildSystemdUnit(getServiceLaunchArgs(), opts);

  writeFileSync(servicePath, service, 'utf-8');

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable mercury.service', { stdio: 'inherit' });
    execSync('systemctl --user start mercury.service', { stdio: 'inherit' });
  } catch (err) {
    console.log(chalk.yellow('  systemd commands failed. Try running manually:'));
    console.log(chalk.dim('    systemctl --user daemon-reload'));
    console.log(chalk.dim('    systemctl --user enable mercury.service'));
    console.log(chalk.dim('    systemctl --user start mercury.service'));
  }

  try {
    execSync(`loginctl enable-linger ${process.env.USER || ''}`, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow('  Enable linger failed (needed for boot-without-login). Try:'));
    console.log(chalk.dim(`    sudo loginctl enable-linger ${process.env.USER || '$USER'}`));
  }

  console.log('');
  console.log(chalk.green('  Mercury service installed (systemd --user)'));
  console.log(chalk.dim(`  Service: ${servicePath}`));
  console.log(chalk.dim(`  Logs: ${join(opts.mercuryHome, 'daemon.log')}`));
  console.log(chalk.dim('  Auto-starts on login. Auto-restarts on crash (5s delay).'));
  console.log('');
  console.log(chalk.dim('  Uninstall: mercury service uninstall'));
  console.log('');
}

function uninstallLinux(): void {
  const servicePath = join(homedir(), '.config', 'systemd', 'user', 'mercury.service');

  if (!existsSync(servicePath)) {
    console.log(chalk.yellow('  Mercury service is not installed.'));
    console.log('');
    process.exit(0);
  }

  try {
    execSync('systemctl --user stop mercury.service', { stdio: 'inherit' });
    execSync('systemctl --user disable mercury.service', { stdio: 'inherit' });
  } catch {
    // may already be stopped
  }

  try {
    unlinkSync(servicePath);
  } catch {
    console.log(chalk.yellow('  Failed to remove service file. Remove manually:'));
    console.log(chalk.dim(`    rm ${servicePath}`));
  }

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  } catch {}

  console.log('');
  console.log(chalk.green('  Mercury service uninstalled'));
  console.log('');
}

function showLinuxStatus(): void {
  const servicePath = join(homedir(), '.config', 'systemd', 'user', 'mercury.service');

  if (!existsSync(servicePath)) {
    console.log(chalk.yellow('  Mercury service is not installed.'));
    console.log(chalk.dim('  Run `mercury service install` to set it up.'));
    console.log('');
    return;
  }

  try {
    const output = execSync('systemctl --user status mercury.service', { encoding: 'utf-8' }).trim();
    console.log(output);
  } catch (err: any) {
    console.log(chalk.yellow('  Could not get service status:'));
    console.log(chalk.dim(`  ${err.message || err}`));
  }
  console.log('');
}

// ─── Windows ─────────────────────────────────────────────────────────────────

function windowsTaskExists(): boolean {
  try {
    execSync(`schtasks /query /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe', shell: 'cmd.exe' });
    return true;
  } catch {
    return false;
  }
}

function windowsRunKeyExists(): boolean {
  try {
    execSync(`reg query "${WIN_RUN_KEY}" /v ${WIN_RUN_VALUE}`, { stdio: 'pipe', shell: 'cmd.exe' });
    return true;
  } catch {
    return false;
  }
}

/** Which autostart form is installed (task wins when both exist). */
export function getWindowsServiceMode(): WindowsServiceMode | null {
  if (process.platform !== 'win32') return null;
  if (windowsTaskExists()) return 'task';
  if (windowsRunKeyExists()) return 'run-key';
  return null;
}

/** Remove every autostart form; returns the labels of what was removed. */
function removeWindowsAutostart(): string[] {
  const removed: string[] = [];
  if (windowsTaskExists()) {
    try {
      execSync(`schtasks /delete /tn "${WIN_TASK_NAME}" /f`, { stdio: 'pipe', shell: 'cmd.exe' });
      removed.push(`scheduled task ${WIN_TASK_NAME}`);
    } catch {}
  }
  if (windowsRunKeyExists()) {
    try {
      execSync(buildRunKeyDeleteCommand(), { stdio: 'pipe', shell: 'cmd.exe' });
      removed.push(`${WIN_RUN_KEY}\\${WIN_RUN_VALUE}`);
    } catch {}
  }
  try { unlinkSync(join(getMercuryHome(), WIN_TASK_XML_FILE)); } catch {}
  return removed;
}

function windowsUserId(): string | undefined {
  const user = process.env.USERNAME;
  if (!user) return undefined;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function errorText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const out = [e?.stderr, e?.stdout].map((b) => (b ? String(b) : '')).join(' ').trim();
  return (out || e?.message || String(err)).replace(/\s+/g, ' ').trim();
}

/**
 * Install the Windows autostart. Tries the Task Scheduler logon task (XML
 * definition: proper quoting, restart-on-failure, no 72h time limit). When
 * Task Scheduler refuses — logon triggers need elevation for standard
 * users ("Access is denied") — falls back to an HKCU Run entry, which any
 * user can write. Reports which form was installed. Returns the mode, or
 * null when neither could be installed.
 */
function installWindows(): WindowsServiceMode | null {
  const home = getMercuryHome();
  const logPath = join(home, 'daemon.log');
  const launchArgs = getServiceLaunchArgs();
  const schtasksHint = buildSchtasksCreateCommand(launchArgs);

  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  // A previous fallback install must not double-start the daemon.
  const hadRunKey = windowsRunKeyExists();

  let taskError = '';
  const xmlPath = join(home, WIN_TASK_XML_FILE);
  try {
    const xml = buildWindowsTaskXml(launchArgs, { workingDirectory: homedir(), userId: windowsUserId() });
    writeFileSync(xmlPath, encodeWindowsTaskXml(xml));
    execSync(`schtasks /create /tn "${WIN_TASK_NAME}" /xml "${xmlPath}" /f`, { stdio: 'pipe', shell: 'cmd.exe' });
  } catch (err) {
    taskError = errorText(err);
    logger.debug({ err: taskError }, 'schtasks /create /xml failed; trying HKCU Run fallback');
  }

  if (!taskError) {
    if (hadRunKey) {
      try { execSync(buildRunKeyDeleteCommand(), { stdio: 'pipe', shell: 'cmd.exe' }); } catch {}
    }
    try {
      execSync(`schtasks /run /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe', shell: 'cmd.exe' });
    } catch {
      console.log(chalk.yellow('  Task created but failed to start immediately. It will start on next login.'));
    }

    console.log('');
    console.log(chalk.green('  Mercury service installed (Windows Task Scheduler)'));
    console.log(chalk.dim(`  Task: ${WIN_TASK_NAME}`));
    console.log(chalk.dim('  Trigger: on logon'));
    console.log(chalk.dim(`  Logs: ${logPath}`));
    console.log(chalk.dim('  Auto-starts on login. Auto-restarts on crash (3 tries, 1 min apart).'));
    console.log('');
    console.log(chalk.dim('  Uninstall: mercury service uninstall'));
    console.log('');
    return 'task';
  }

  const denied = /access is denied|0x80070005|E_ACCESSDENIED/i.test(taskError);
  console.log(chalk.yellow(`  Task Scheduler refused the logon task${denied ? ' (needs an elevated prompt for standard users)' : ''}:`));
  console.log(chalk.dim(`    ${taskError}`));
  console.log(chalk.dim('  Falling back to a per-user startup entry (HKCU Run key — no elevation needed).'));

  try {
    execSync(buildRunKeyAddCommand(runKeyLaunchArgs(launchArgs)), { stdio: 'pipe', shell: 'cmd.exe' });
  } catch (err) {
    console.log(chalk.red(`  Could not write the startup entry either: ${errorText(err)}`));
    console.log(chalk.yellow('  Install the scheduled task from an Administrator prompt:'));
    console.log(chalk.dim(`    ${schtasksHint}`));
    console.log(chalk.dim('  Mercury will still run for this session; run `mercury up` after each login until then.'));
    console.log('');
    return null;
  }

  if (!getDaemonStatus().running) {
    if (!tryAutoDaemonize()) {
      console.log(chalk.yellow('  Startup entry written but the daemon failed to start now. It will start on next login.'));
    }
  }

  console.log('');
  console.log(chalk.green('  Mercury autostart installed (Windows Run key — standard user)'));
  console.log(chalk.dim(`  Entry: ${WIN_RUN_KEY}\\${WIN_RUN_VALUE}`));
  console.log(chalk.dim('  Trigger: on logon'));
  console.log(chalk.dim(`  Logs: ${logPath}`));
  console.log(chalk.yellow('  Auto-starts on login. No crash recovery in this mode — for restart-on-failure,'));
  console.log(chalk.yellow('  run `mercury service install` from an Administrator prompt (installs a scheduled task).'));
  console.log('');
  console.log(chalk.dim('  Uninstall: mercury service uninstall'));
  console.log('');
  return 'run-key';
}

function uninstallWindows(): void {
  const removed = removeWindowsAutostart();
  if (removed.length === 0) {
    console.log(chalk.yellow('  Mercury autostart not found or failed to delete. Remove manually:'));
    console.log(chalk.dim(`    schtasks /delete /tn "${WIN_TASK_NAME}" /f`));
    console.log(chalk.dim(`    ${buildRunKeyDeleteCommand()}`));
    console.log('');
    return;
  }
  console.log('');
  console.log(chalk.green('  Mercury service uninstalled'));
  for (const label of removed) console.log(chalk.dim(`  Removed: ${label}`));
  console.log('');
}

function showWindowsStatus(): void {
  const mode = getWindowsServiceMode();
  if (mode === 'task') {
    try {
      const output = execSync(`schtasks /query /tn "${WIN_TASK_NAME}" /fo list`, {
        encoding: 'utf-8',
        shell: 'cmd.exe',
      }).trim();
      console.log(`  ${chalk.green('Autostart: Task Scheduler logon task')}`);
      console.log(output);
      console.log('');
      return;
    } catch {
      // fall through to the generic message
    }
  }
  if (mode === 'run-key') {
    const daemon = getDaemonStatus();
    console.log(`  ${chalk.green('Autostart: HKCU Run entry')} ${chalk.dim(`(${WIN_RUN_KEY}\\${WIN_RUN_VALUE})`)}`);
    console.log(`  Daemon: ${daemon.running ? chalk.green(`running (PID: ${daemon.pid})`) : chalk.yellow('not running')}`);
    console.log(chalk.dim('  No crash recovery in this mode; an Administrator `mercury service install` upgrades it to a scheduled task.'));
    console.log('');
    return;
  }
  console.log(chalk.yellow('  Mercury service is not installed.'));
  console.log(chalk.dim('  Run `mercury service install` to set it up.'));
  console.log('');
}
