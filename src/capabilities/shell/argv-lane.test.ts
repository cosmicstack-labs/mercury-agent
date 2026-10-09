import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARGV_ALLOWLIST,
  evaluateArgvPolicy,
  minimalEnv,
  pinnedPath,
  pinnedSearchDirs,
  planArgvExecution,
  resolveFromDirs,
  tokenizePosix,
} from './argv-lane.js';

describe('tokenizePosix', () => {
  const ok = (cmd: string) => {
    const r = tokenizePosix(cmd);
    if (!r.ok) throw new Error(`expected ${cmd} to tokenize: ${r.reason}`);
    return r.argv;
  };

  it('splits on whitespace', () => {
    expect(ok('ls -la  src\tdocs')).toEqual(['ls', '-la', 'src', 'docs']);
  });

  it('single quotes are fully literal (metachars included)', () => {
    expect(ok("grep 'a|b; $HOME `x` *' file")).toEqual(['grep', 'a|b; $HOME `x` *', 'file']);
  });

  it('double quotes keep spaces and literal globs; \\" and \\\\ unescape', () => {
    expect(ok('find . -name "*.ts"')).toEqual(['find', '.', '-name', '*.ts']);
    expect(ok('echo "say \\"hi\\" \\\\ there"')).toEqual(['echo', 'say "hi" \\ there']);
  });

  it('adjacent quoted and unquoted parts form one word', () => {
    expect(ok(`echo a"b c"'d'e`)).toEqual(['echo', 'ab cde']);
    expect(ok('echo ""')).toEqual(['echo', '']);
  });

  it('backslash escapes outside quotes', () => {
    expect(ok('echo a\\ b \\;')).toEqual(['echo', 'a b', ';']);
  });

  it.each([
    ['ls | head', '|'],
    ['ls; reboot', ';'],
    ['ls && pwd', '&'],
    ['ls &', '&'],
    ['echo x > out', '>'],
    ['cat < in', '<'],
    ['echo $HOME', '$'],
    ['echo ${HOME}', '$'],
    ['echo $(id)', '$'],
    ['echo `id`', '`'],
    ['echo "$HOME"', 'expansion inside double quotes'],
    ['echo "`id`"', 'expansion inside double quotes'],
    ["head $'\\x2fetc'", '$'],
    ['ls *.ts', '*'],
    ['ls file?', '?'],
    ['ls [ab]', '['],
    ['echo {a,b}', '{'],
    ['cat ~/secret', '~'],
    ['echo hi # comment', 'comment'],
    ['echo !!', '!'],
    ['( ls )', '('],
    ['ls\nreboot', '\n'],
    ['echo "unterminated', 'unterminated'],
    ["echo 'unterminated", 'unterminated'],
    ['echo trailing\\', 'line continuation'],
    ['FOO=bar ls', 'assignment'],
    ['', 'empty'],
  ])('rejects %j', (cmd, why) => {
    const r = tokenizePosix(cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why === '\n' ? '"\\n"' : why);
  });
});

describe('evaluateArgvPolicy', () => {
  it('only allowlisted programs, by bare name', () => {
    expect(evaluateArgvPolicy('ls -la').ok).toBe(true);
    expect(evaluateArgvPolicy('npm test').ok).toBe(false);
    expect(evaluateArgvPolicy('curl http://example.com').ok).toBe(false);
    expect(evaluateArgvPolicy('./ls').ok).toBe(false);
    expect(evaluateArgvPolicy('/tmp/evil/ls').ok).toBe(false);
    expect(evaluateArgvPolicy('constructor').ok).toBe(false);
    expect(evaluateArgvPolicy('__proto__').ok).toBe(false);
  });

  it('applies the side-effect deny list to argv after quote removal', () => {
    expect(evaluateArgvPolicy('find . "-exec" id ;').ok).toBe(false);
    expect(evaluateArgvPolicy("find . '-delete'").ok).toBe(false);
    expect(evaluateArgvPolicy('git log "--output=x"').ok).toBe(false);
    expect(evaluateArgvPolicy('wc --files0-from=list').ok).toBe(false);
  });

  it('git: read subcommands only, nothing before the subcommand', () => {
    expect(evaluateArgvPolicy('git status').ok).toBe(true);
    expect(evaluateArgvPolicy('git log --oneline -n 5').ok).toBe(true);
    expect(evaluateArgvPolicy('git branch -a').ok).toBe(true);
    expect(evaluateArgvPolicy('git branch --contains HEAD').ok).toBe(true);
    expect(evaluateArgvPolicy('git -c core.pager=evil log').ok).toBe(false);
    expect(evaluateArgvPolicy('git -C /elsewhere status').ok).toBe(false);
    expect(evaluateArgvPolicy('git commit -m x').ok).toBe(false);
    expect(evaluateArgvPolicy('git push').ok).toBe(false);
    expect(evaluateArgvPolicy('git branch -D main').ok).toBe(false);
    expect(evaluateArgvPolicy('git branch -f main HEAD~1').ok).toBe(false);
    expect(evaluateArgvPolicy('git branch --set-upstream-to=origin/x').ok).toBe(false);
    expect(evaluateArgvPolicy('git diff --textconv').ok).toBe(false);
  });

  it('rg: --pre and --search-zip/-z (spawn programs) are denied', () => {
    expect(evaluateArgvPolicy('rg -n pattern src').ok).toBe(true);
    expect(evaluateArgvPolicy('rg --pre-glob "*.x" pattern').ok).toBe(true);
    expect(evaluateArgvPolicy('rg -z pattern').ok).toBe(false);
    expect(evaluateArgvPolicy('rg -nz pattern').ok).toBe(false);
    expect(evaluateArgvPolicy('rg --search-zip pattern').ok).toBe(false);
  });

  it('tree -R (writes 00Tree.html per directory) is denied', () => {
    expect(evaluateArgvPolicy('tree -a -L 2').ok).toBe(true);
    expect(evaluateArgvPolicy('tree -R -H .').ok).toBe(false);
  });

  it('ps: positive allowlist (no e/E environment dump)', () => {
    expect(evaluateArgvPolicy('ps aux').ok).toBe(true);
    expect(evaluateArgvPolicy('ps -ax -o pid,command').ok).toBe(true);
    expect(evaluateArgvPolicy('ps -p 123').ok).toBe(true);
    expect(evaluateArgvPolicy('ps eww').ok).toBe(false);
    expect(evaluateArgvPolicy('ps -E').ok).toBe(false);
    expect(evaluateArgvPolicy('ps -ef').ok).toBe(false);
  });

  it('cd takes at most one directory', () => {
    expect(evaluateArgvPolicy('cd src').ok).toBe(true);
    expect(evaluateArgvPolicy('cd').ok).toBe(true);
    expect(evaluateArgvPolicy('cd a b').ok).toBe(false);
  });

  it('allowlist is frozen', () => {
    expect(Object.isFrozen(ARGV_ALLOWLIST)).toBe(true);
  });
});

describe('pinned binaries and minimal env (#103)', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('pinned search dirs and PATH never come from process.env.PATH', () => {
    const dirs = pinnedSearchDirs('linux', { PATH: '/tmp/evil:/usr/bin' });
    expect(dirs).not.toContain('/tmp/evil');
    expect(dirs).toContain('/usr/bin');
    expect(pinnedPath('linux', {})).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin');
  });

  it('on Termux, pins $PREFIX/bin first (there is no /usr/bin there)', () => {
    const prefix = '/data/data/com.termux/files/usr';
    expect(pinnedSearchDirs('android', { PREFIX: prefix })[0]).toBe(join(prefix, 'bin'));
    expect(pinnedSearchDirs('linux', { PREFIX: '/usr' })).not.toContain('/usr/bin/bin');
  });

  it('resolves from the given dirs only and skips world-writable binaries', () => {
    if (process.platform === 'win32') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-pin-')));
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    writeFileSync(join(bad, 'ls'), '#!/bin/sh\n');
    chmodSync(join(bad, 'ls'), 0o777);
    writeFileSync(join(good, 'ls'), '#!/bin/sh\n');
    chmodSync(join(good, 'ls'), 0o755);
    expect(resolveFromDirs('ls', [bad, good])).toBe(join(good, 'ls'));
    expect(resolveFromDirs('ls', ['relative/dir'])).toBeUndefined();
    expect(resolveFromDirs('nope', [good])).toBeUndefined();
  });

  it('minimal env carries the pinned PATH and drops secrets and loader/config vars', () => {
    const env = minimalEnv({
      PATH: '/tmp/evil:/usr/bin',
      HOME: '/home/jane',
      ANTHROPIC_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      LD_PRELOAD: '/tmp/x.so',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      GIT_EXTERNAL_DIFF: '/tmp/x.sh',
      RIPGREP_CONFIG_PATH: '/tmp/rg',
      USER: 'jane',
    }, 'linux');
    expect(env.PATH).toBe(pinnedPath('linux'));
    expect(env.HOME).toBe('/home/jane');
    expect(env.USER).toBe('jane');
    for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_EXTERNAL_DIFF', 'RIPGREP_CONFIG_PATH']) {
      expect(env[k]).toBeUndefined();
    }
  });
});

describe('planArgvExecution', () => {
  const resolver = (p: string) => `/usr/bin/${p}`;

  it('plans execFile with the resolved absolute binary and argv tail', () => {
    expect(planArgvExecution('cat "my file.txt"', resolver)).toEqual({
      kind: 'exec', file: '/usr/bin/cat', args: ['my file.txt'], argv: ['cat', 'my file.txt'],
    });
  });

  it('hardens git against repo-configured programs', () => {
    const plan = planArgvExecution('git diff --stat', resolver);
    expect(plan).toMatchObject({ kind: 'exec', file: '/usr/bin/git' });
    if (plan?.kind !== 'exec') throw new Error('expected exec');
    expect(plan.args).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--stat']);
  });

  it('cd is an in-process builtin', () => {
    expect(planArgvExecution('cd src', resolver)).toEqual({ kind: 'builtin', argv: ['cd', 'src'] });
  });

  it('returns null (approval lane) for pipelines, policy failures and unresolved binaries', () => {
    expect(planArgvExecution('git log | head', resolver)).toBeNull();
    expect(planArgvExecution('find . -delete', resolver)).toBeNull();
    expect(planArgvExecution('ls', () => undefined)).toBeNull();
  });
});
