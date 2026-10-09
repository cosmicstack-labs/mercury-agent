import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  buildWindowsTaskXml,
  encodeWindowsTaskXml,
  pinnedServicePath,
  serviceFileOptions,
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

describe('service PATH pinning (ROADMAP P2.2, #103)', () => {
  const nodeDir = '/Users/jane/.nvm/versions/node/v20.11.0/bin';

  it('pins a fixed PATH of system dirs plus the node directory (darwin, linux)', () => {
    expect(pinnedServicePath('darwin', nodeDir)).toBe(`/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:${nodeDir}`);
    expect(pinnedServicePath('linux', '/usr/bin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin');
    // A relative node dir is never written.
    expect(pinnedServicePath('linux', 'node_modules/.bin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin');
  });

  it('pins Windows to System32, Git and the node directory', () => {
    const p = pinnedServicePath('win32', 'C:\\Program Files\\nodejs', { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' });
    expect(p.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\nodejs',
    ]);
  });

  it('generated plist and systemd unit carry the pinned PATH, not the installing shell PATH', () => {
    const original = process.env.PATH;
    process.env.PATH = `/tmp/evil-bin:./node_modules/.bin:${original}`;
    try {
      const opts = serviceFileOptions();
      expect(opts.pathEnv).not.toContain('/tmp/evil-bin');
      expect(opts.pathEnv).not.toContain('node_modules');
      const args = ['/usr/local/bin/node', '/opt/mercury/dist/index.js', 'start', '--daemon'];
      const plist = buildLaunchAgentPlist(args, opts);
      expect(plist).toContain(`<key>PATH</key>\n    <string>${opts.pathEnv}</string>`);
      expect(plist).not.toContain('/tmp/evil-bin');
      const unit = buildSystemdUnit(args, opts);
      expect(unit).toContain(`Environment=PATH=${opts.pathEnv}`);
      expect(unit).not.toContain('/tmp/evil-bin');
    } finally {
      process.env.PATH = original;
    }
  });
});
