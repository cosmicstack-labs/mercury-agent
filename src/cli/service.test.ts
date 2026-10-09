import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildLaunchAgentPlist,
  buildRunKeyAddCommand,
  buildRunKeyDeleteCommand,
  buildSchtasksCreateCommand,
  buildSystemdUnit,
  buildWindowsCommandLine,
  buildTermuxBootScript,
  buildWindowsTaskXml,
  encodeWindowsTaskXml,
  installService,
  isServiceInstalled,
  isServiceRunning,
  removeTermuxBootScript,
  showServiceStatus,
  stopService,
  teardownService,
  termuxBootScriptPath,
  uninstallService,
  writeTermuxBootScript,
  quoteWindowsArg,
  resolveDistPath,
  runKeyLaunchArgs,
  WIN_RUN_KEY,
  WIN_TASK_NAME,
} from './service.js';

/**
 * Service-file contract: the strings handed to launchd / systemd / Task
 * Scheduler / reg.exe must survive paths with spaces (Windows' default
 * `C:\Program Files\nodejs\node.exe`), and the dist path must resolve from
 * the real entry script on every npm layout — not from `bin/../lib`.
 */

const WIN_ARGS = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js',
  'start',
  '--daemon',
];

describe('Windows command-line quoting', () => {
  it('quotes only the words that need it and escapes embedded quotes', () => {
    expect(quoteWindowsArg('start')).toBe('start');
    expect(quoteWindowsArg('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('')).toBe('""');
  });

  it('builds the launch command line with spaced paths intact', () => {
    expect(buildWindowsCommandLine(WIN_ARGS)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js" start --daemon',
    );
  });

  it('escapes the nested quotes inside schtasks /tr "…" (#13)', () => {
    const cmd = buildSchtasksCreateCommand(WIN_ARGS);
    expect(cmd).toBe(
      `schtasks /create /tn "${WIN_TASK_NAME}" /tr "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js\\" start --daemon" /sc onlogon /rl limited /f`,
    );
    // The /tr payload is exactly one cmd.exe argument: every inner quote is escaped,
    // so the only bare quotes are the ones wrapping /tn and /tr values.
    const bareQuotes = cmd.replace(/\\"/g, '').match(/"/g) ?? [];
    expect(bareQuotes).toHaveLength(4);
  });

  it('escapes the nested quotes in the HKCU Run `reg add /d "…"` payload', () => {
    const cmd = buildRunKeyAddCommand(runKeyLaunchArgs(WIN_ARGS));
    expect(cmd.startsWith(`reg add "${WIN_RUN_KEY}" /v MercuryAgent /t REG_SZ /d "`)).toBe(true);
    expect(cmd.endsWith('" /f')).toBe(true);
    expect(cmd).toContain('\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\Jane Doe\\');
    // The Run entry launches `mercury start` (spawns the hidden daemon and
    // exits) — never `--daemon`, which would pin a console window open.
    expect(cmd).not.toContain('--daemon');
    expect(cmd).toContain('index.js\\" start"');
    expect(buildRunKeyDeleteCommand()).toBe(`reg delete "${WIN_RUN_KEY}" /v MercuryAgent /f`);
  });
});

describe('Windows Task Scheduler XML', () => {
  it('separates Command from Arguments, scopes the logon trigger, and sets restart-on-failure', () => {
    const xml = buildWindowsTaskXml(WIN_ARGS, { workingDirectory: 'C:\\Users\\Jane Doe', userId: 'DESKTOP\\Jane Doe' });
    expect(xml).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(xml).toContain(
      '<Arguments>&quot;C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js&quot; start --daemon</Arguments>',
    );
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\Jane Doe</WorkingDirectory>');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>DESKTOP\\Jane Doe</UserId>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    // Crash recovery + no 72h kill + single instance.
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('omits UserId when the account is unknown and XML-escapes the description', () => {
    const xml = buildWindowsTaskXml(WIN_ARGS, { workingDirectory: 'C:\\', description: 'A & B <c>' });
    expect(xml).not.toContain('<UserId>');
    expect(xml).toContain('<Description>A &amp; B &lt;c&gt;</Description>');
  });

  it('encodes the task file as UTF-16LE with a BOM (what schtasks /xml reads)', () => {
    const buf = encodeWindowsTaskXml('<Task/>');
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
    expect(buf.toString('utf16le').slice(1)).toBe('<Task/>');
  });
});

describe('launchd plist and systemd unit', () => {
  const opts = { mercuryHome: '/Users/jane/.mercury', userHome: '/Users/jane', pathEnv: '/usr/local/bin:/usr/bin:/bin' };
  const args = ['/usr/local/bin/node', '/usr/local/lib/node_modules/@cosmicstack/mercury-agent/dist/index.js', 'start', '--daemon'];

  it('plist lists every launch word as its own <string> and wires logs/env', () => {
    const plist = buildLaunchAgentPlist(args, opts);
    expect(plist).toContain('<string>com.cosmicstack.mercury</string>');
    for (const a of args) expect(plist).toContain(`    <string>${a}</string>`);
    expect(plist).toContain('<string>/Users/jane/.mercury/daemon.log</string>');
    expect(plist).toContain('<string>/Users/jane/.mercury/daemon-error.log</string>');
    expect(plist).toContain('<key>HOME</key>\n    <string>/Users/jane</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it('plist XML-escapes a path with an ampersand', () => {
    const plist = buildLaunchAgentPlist(['/opt/a&b/node', 'start'], opts);
    expect(plist).toContain('<string>/opt/a&amp;b/node</string>');
  });

  it('systemd unit quotes ExecStart words that contain spaces', () => {
    const unit = buildSystemdUnit(['/opt/my node/bin/node', '/opt/mercury/dist/index.js', 'start', '--daemon'], opts);
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" /opt/mercury/dist/index.js start --daemon');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StandardOutput=append:/Users/jane/.mercury/daemon.log');
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('resolveDistPath', () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('follows the POSIX npm bin symlink to the real dist/index.js', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-dist-posix-')));
    const dist = join(root, 'lib', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist');
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(dist, 'index.js'), '// entry');
    symlinkSync(join('..', 'lib', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist', 'index.js'), join(root, 'bin', 'mercury'));
    expect(resolveDistPath(join(root, 'bin', 'mercury'))).toBe(join(dist, 'index.js'));
  });

  it('resolves the Windows npm layout, where argv[1] is already the real dist/index.js (no bin/../lib)', () => {
    // %APPDATA%\npm\node_modules\... — the .cmd shim hands node the real file.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-dist-win-')));
    const dist = join(root, 'npm', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '// entry');
    const resolved = resolveDistPath(join(dist, 'index.js'));
    expect(resolved).toBe(join(dist, 'index.js'));
    expect(resolved).not.toContain(join('npm', '..', 'lib'));
  });

  it('falls back to the module location when argv[1] is not a real file (bun-virtual path)', () => {
    root = mkdtempSync(join(tmpdir(), 'mercury-dist-self-'));
    const self = join(root, 'dist', 'index.js');
    mkdirSync(join(root, 'dist'));
    writeFileSync(self, '// bundle');
    expect(resolveDistPath('/$bunfs/root/mercury', pathToFileURL(self).href)).toBe(self);
  });

  it('falls back to the nvm guess when nothing else resolves', () => {
    const guess = resolveDistPath(undefined, 'file:///nowhere/src/cli/service.ts', 'v20.11.0');
    expect(guess.endsWith(join('.nvm', 'versions', 'node', 'v20.11.0', 'lib', 'node_modules', '@cosmicstack', 'mercury-agent', 'dist', 'index.js'))).toBe(true);
  });
});

describe('Termux:Boot script (P2.8)', () => {
  const opts = { prefix: '/data/data/com.termux/files/usr', mercuryHome: '/data/data/com.termux/files/home/.mercury' };

  it('uses the Termux shell, takes a wake lock before `mercury up`, and logs boot output', () => {
    const script = buildTermuxBootScript(['/data/data/com.termux/files/usr/bin/node', '/data/x/dist/index.js', 'up'], opts);
    const lines = script.split('\n');
    expect(lines[0]).toBe('#!/data/data/com.termux/files/usr/bin/sh');
    const wake = lines.indexOf('termux-wake-lock');
    const up = lines.findIndex((l) => l.startsWith('/data/data/com.termux/files/usr/bin/node /data/x/dist/index.js up'));
    expect(wake).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(wake);
    expect(lines[up]).toContain('>> /data/data/com.termux/files/home/.mercury/boot.log 2>&1');
    expect(script).toContain('export PATH="/data/data/com.termux/files/usr/bin:$PATH"');
    expect(script.endsWith('\n')).toBe(true);
  });

  it('single-quotes argv words that the boot shell would split or expand', () => {
    const script = buildTermuxBootScript(["/home/my dir/it's/node", '$HOME/x', 'up'], opts);
    expect(script).toContain(String.raw`'/home/my dir/it'\''s/node' '$HOME/x' up >>`);
  });

  it('falls back to the default Termux prefix', () => {
    expect(buildTermuxBootScript(['mercury', 'up'], { mercuryHome: '/m' }).split('\n')[0])
      .toBe('#!/data/data/com.termux/files/usr/bin/sh');
  });

  it('writes ~/.termux/boot/mercury.sh executable under a fake HOME and removes it', () => {
    const home = mkdtempSync(join(tmpdir(), 'mercury-termux-'));
    try {
      const path = writeTermuxBootScript(['mercury', 'up'], { ...opts, home });
      expect(path).toBe(termuxBootScriptPath(home));
      expect(path.replace(/\\/g, '/').endsWith('/.termux/boot/mercury.sh')).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('termux-wake-lock');
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o755);
      // Re-install over an existing (non-executable) file restores the mode.
      if (process.platform !== 'win32') {
        writeFileSync(path, 'old', { mode: 0o644 });
        writeTermuxBootScript(['mercury', 'up'], { ...opts, home });
        expect(statSync(path).mode & 0o777).toBe(0o755);
      }
      expect(removeTermuxBootScript(path)).toBe(true);
      expect(existsSync(path)).toBe(false);
      // Removing an absent script is still "gone".
      expect(removeTermuxBootScript(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('service install/uninstall/status on Termux (fake HOME, platform android)', () => {
  let home: string;
  const realPlatform = process.platform;
  let logs: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-termux-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('MERCURY_HOME', join(home, '.mercury'));
    vi.stubEnv('TERMUX_VERSION', '0.118.0');
    vi.stubEnv('PREFIX', '/data/data/com.termux/files/usr');
    Object.defineProperty(process, 'platform', { value: 'android', configurable: true });
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('install writes the boot script and reports it; status and uninstall recognise it', () => {
    const bootPath = termuxBootScriptPath(home);
    expect(isServiceInstalled()).toBe(false);

    expect(installService()).toBe(true);
    expect(existsSync(bootPath)).toBe(true);
    const script = readFileSync(bootPath, 'utf8');
    expect(script.split('\n')[0]).toBe('#!/data/data/com.termux/files/usr/bin/sh');
    expect(script).toMatch(/termux-wake-lock\n.* up >> /);
    expect(script).not.toContain('--daemon');
    expect(logs.join('\n')).toContain('Termux:Boot');
    expect(logs.join('\n')).toContain(bootPath);

    expect(isServiceInstalled()).toBe(true);
    // Nothing supervises the daemon: no service process to stop or query.
    expect(isServiceRunning()).toBe(false);
    expect(stopService()).toBe(true);

    logs.length = 0;
    showServiceStatus();
    expect(logs.join('\n')).toContain('Autostart: Termux:Boot script');
    expect(logs.join('\n')).toContain(bootPath);

    logs.length = 0;
    expect(uninstallService()).toBe(true);
    expect(existsSync(bootPath)).toBe(false);
    expect(logs.join('\n')).toContain('boot script removed');
    expect(isServiceInstalled()).toBe(false);

    logs.length = 0;
    showServiceStatus();
    expect(logs.join('\n')).toMatch(/not installed/);
  });

  it('uninstall without a boot script reports it and does not exit', () => {
    expect(uninstallService()).toBe(false);
    expect(logs.join('\n')).toMatch(/not installed/);
  });

  it('teardownService (mercury uninstall) removes the boot script', () => {
    expect(teardownService()).toEqual({ removed: false });
    installService();
    expect(teardownService()).toEqual({ removed: true, path: termuxBootScriptPath(home) });
    expect(existsSync(termuxBootScriptPath(home))).toBe(false);
  });
});
