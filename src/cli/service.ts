import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { execFileSync, execSync } from 'node:child_process';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const SERVICE_NAME = 'mercury';
const SERVICE_DESC = 'Mercury — Soul-Driven AI Agent';
const WIN_TASK_NAME = 'MercuryAgent';

export function isServiceInstalled(): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    return existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.cosmicstack.mercury.plist'));
  } else if (platform === 'linux') {
    return existsSync(join(homedir(), '.config', 'systemd', 'user', 'mercury.service'));
  } else if (platform === 'win32') {
    try {
      runSchtasks(['/query', '/tn', WIN_TASK_NAME], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function getNodeBinPath(): string {
  return process.execPath;
}

export function getDistPath(argvEntry = process.argv[1]): string {
  if (argvEntry) {
    return resolve(argvEntry);
  }
  return join(homedir(), '.nvm', 'versions', 'node', `v${process.version.slice(1)}`, 'lib', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist', 'index.js');
}

function quoteWindowsTaskPath(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

export function buildWindowsTaskCommand(nodeBin: string, scriptPath: string): string {
  return `${quoteWindowsTaskPath(nodeBin)} ${quoteWindowsTaskPath(scriptPath)} start --daemon`;
}

export function buildWindowsCreateTaskArgs(taskName: string, taskCommand: string): string[] {
  return ['/create', '/tn', taskName, '/tr', taskCommand, '/sc', 'onlogon', '/rl', 'limited', '/f'];
}

function runSchtasks(args: string[], options: Parameters<typeof execFileSync>[2] = {}): Buffer | string {
  return execFileSync('schtasks', args, options);
}

function formatManualSchtasksCommand(args: string[]): string {
  const quotedArgs = args.map((arg) => {
    if (!/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
  });
  return `schtasks ${quotedArgs.join(' ')}`;
}

export function installService(): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    installMac();
  } else if (platform === 'linux') {
    installLinux();
  } else if (platform === 'win32') {
    installWindows();
  } else {
    console.log(chalk.red(`  Unsupported platform: ${platform}`));
    process.exit(1);
  }
}

export function uninstallService(): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    uninstallMac();
  } else if (platform === 'linux') {
    uninstallLinux();
  } else if (platform === 'win32') {
    uninstallWindows();
  } else {
    console.log(chalk.red(`  Unsupported platform: ${platform}`));
    process.exit(1);
  }
}

export function showServiceStatus(): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    showMacStatus();
  } else if (platform === 'linux') {
    showLinuxStatus();
  } else if (platform === 'win32') {
    showWindowsStatus();
  }
}

function installMac(): void {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, 'com.cosmicstack.mercury.plist');

  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true });
  }

  const nodeBin = getNodeBinPath();
  const scriptPath = getDistPath();
  const home = getMercuryHome();
  const logPath = join(home, 'daemon.log');
  const errPath = join(home, 'daemon-error.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cosmicstack.mercury</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${scriptPath}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
</dict>
</plist>`;

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

function installLinux(): void {
  const systemdDir = join(homedir(), '.config', 'systemd', 'user');

  if (!existsSync(systemdDir)) {
    mkdirSync(systemdDir, { recursive: true });
  }

  const servicePath = join(systemdDir, 'mercury.service');
  const nodeBin = getNodeBinPath();
  const scriptPath = getDistPath();
  const home = getMercuryHome();

  const service = `[Unit]
Description=${SERVICE_DESC}
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${scriptPath} start --daemon
Restart=on-failure
RestartSec=5
Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${homedir()}
WorkingDirectory=${homedir()}
StandardOutput=append:${join(home, 'daemon.log')}
StandardError=append:${join(home, 'daemon-error.log')}

[Install]
WantedBy=default.target`;

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
  console.log(chalk.dim(`  Logs: ${join(home, 'daemon.log')}`));
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

function installWindows(): void {
  const nodeBin = getNodeBinPath();
  const scriptPath = getDistPath();
  const home = getMercuryHome();
  const logPath = join(home, 'daemon.log');
  const taskCommand = buildWindowsTaskCommand(nodeBin, scriptPath);
  const createArgs = buildWindowsCreateTaskArgs(WIN_TASK_NAME, taskCommand);

  try {
    runSchtasks(createArgs, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow('  schtasks create failed. Try running from an Administrator cmd:'));
    console.log(chalk.dim(`    ${formatManualSchtasksCommand(createArgs)}`));
    console.log('');
    return;
  }

  try {
    runSchtasks(['/run', '/tn', WIN_TASK_NAME], { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow('  Task created but failed to start immediately. It will start on next login.'));
  }

  console.log('');
  console.log(chalk.green('  Mercury service installed (Windows Task Scheduler)'));
  console.log(chalk.dim(`  Task: ${WIN_TASK_NAME}`));
  console.log(chalk.dim(`  Trigger: on logon`));
  console.log(chalk.dim(`  Logs: ${logPath}`));
  console.log(chalk.dim('  Auto-starts on login. Use --daemon flag for crash recovery.'));
  console.log('');
  console.log(chalk.dim('  Uninstall: mercury service uninstall'));
  console.log('');
}

function uninstallWindows(): void {
  try {
    runSchtasks(['/delete', '/tn', WIN_TASK_NAME, '/f'], { stdio: 'inherit' });
    console.log('');
    console.log(chalk.green('  Mercury service uninstalled'));
    console.log('');
  } catch {
    console.log(chalk.yellow('  Task not found or failed to delete. Remove manually:'));
    console.log(chalk.dim(`    schtasks /delete /tn "${WIN_TASK_NAME}" /f`));
    console.log('');
  }
}

function showWindowsStatus(): void {
  try {
    const output = String(runSchtasks(['/query', '/tn', WIN_TASK_NAME, '/fo', 'list'], {
      encoding: 'utf-8',
    })).trim();
    console.log(output);
    console.log('');
  } catch {
    console.log(chalk.yellow('  Mercury service is not installed.'));
    console.log(chalk.dim('  Run `mercury service install` to set it up.'));
    console.log('');
  }
}
