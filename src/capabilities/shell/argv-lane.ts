/**
 * Argv lane for auto-approved shell commands (ROADMAP P2.2, ADR-016).
 *
 * A command is auto-approved only when it
 *   1. tokenises cleanly into argv with a strict POSIX tokenizer that rejects
 *      everything a shell would expand or interpret (`$`, backticks,
 *      redirection, pipes, `;`, `&`, unquoted globs, `~`, `#`, `!`, subshells),
 *   2. has an `argv[0]` in a fixed allowlist of read-only programs,
 *   3. passes that program's argv policy (the SIDE_EFFECT_FLAGS deny list plus
 *      positive allowlists where a deny list is not enough), and
 *   4. resolves to an executable in a PATH pinned to system directories,
 *      resolved once per process and never read from `process.env.PATH`.
 *
 * Such a command is executed with `execFile(absBinary, argv, { env: minimal })`
 * — never through `sh -c` — so what was checked is exactly what runs.
 * Everything else (pipelines included) goes to the approval lane, which
 * prompts with the exact string and may still use the shell.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

// ─── Tokenizer ───────────────────────────────────────────────────────────────

export type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/**
 * Characters that make an unquoted word mean something to a shell beyond a
 * literal string. Any of them outside quotes rejects the command from the
 * argv lane (it may still run through the approval lane).
 */
const UNQUOTED_REJECT = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '~', '!', '\n', '\r']);

/**
 * Strict POSIX-style tokenizer. Supports whitespace separation, single
 * quotes (fully literal), double quotes (literal except `\"` and `\\`) and
 * backslash escapes outside quotes. Rejects — rather than interprets — every
 * construct whose meaning depends on a shell: expansions (`$`, backticks,
 * `~`), redirection, pipes and lists, globs, history (`!`), comments (`#` at
 * word start), subshells and brace groups. Inside double quotes `$` and
 * backticks still expand in a real shell, so they are rejected there too.
 */
export function tokenizePosix(command: string): TokenizeResult {
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  const s = command;

  while (i < s.length) {
    const ch = s[i];

    if (ch === ' ' || ch === '\t') {
      if (inWord) { argv.push(word); word = ''; inWord = false; }
      i++;
      continue;
    }

    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return { ok: false, reason: 'unterminated single quote' };
      word += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const c = s[i];
        if (c === '"') { closed = true; i++; break; }
        if (c === '$' || c === '`') return { ok: false, reason: `expansion inside double quotes (${c})` };
        if (c === '\\') {
          const n = s[i + 1];
          if (n === '"' || n === '\\') { word += n; i += 2; continue; }
          if (n === '$' || n === '`') { word += n; i += 2; continue; }
          if (n === '\n' || n === undefined) return { ok: false, reason: 'line continuation' };
          word += c; i++;
          continue;
        }
        word += c;
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated double quote' };
      inWord = true;
      continue;
    }

    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined || n === '\n' || n === '\r') return { ok: false, reason: 'line continuation' };
      word += n;
      inWord = true;
      i += 2;
      continue;
    }

    if (ch === '#' && !inWord) return { ok: false, reason: 'comment' };
    if (UNQUOTED_REJECT.has(ch)) return { ok: false, reason: `shell metacharacter ${JSON.stringify(ch)}` };
    // `=` is literal for a command's argv, but `VAR=x cmd` is an assignment
    // prefix in a shell; only the first word can be one.
    if (ch === '=' && argv.length === 0 && inWord && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
      return { ok: false, reason: 'environment assignment prefix' };
    }
    if (ch.charCodeAt(0) < 0x20) return { ok: false, reason: 'control character' };

    word += ch;
    inWord = true;
    i++;
  }

  if (inWord) argv.push(word);
  if (argv.length === 0) return { ok: false, reason: 'empty command' };
  return { ok: true, argv };
}

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Per-command flags that turn a "read-only" command into a write or an
 * exec. Each entry is matched against the command word, then its flag
 * pattern against the space-joined argv (after quote removal, so a quoted
 * `"-exec"` is seen). Flags are anchored at a token start and must end at
 * whitespace, `=` or end-of-string, so `-fprint0` and `-fls` cannot hide
 * behind a `\b` that stops at the digit (#71 family).
 */
export const SIDE_EFFECT_FLAGS: ReadonlyArray<{ command: RegExp; flags: RegExp }> = [
  // find: -exec/-execdir/-ok/-okdir run commands; -delete deletes;
  // -fprint/-fprint0/-fprintf/-fls write attacker-chosen files;
  // -files0-from dereferences a path list the literal-path gate never saw.
  { command: /^find(?:\s|$)/, flags: /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprintf|fprint0|fprint|fls|files0-from)(?=\s|=|$)/ },
  // tree -o FILE / --output FILE writes the listing to a file.
  { command: /^tree(?:\s|$)/, flags: /(?:^|\s)(?:-[A-Za-z]*o[A-Za-z]*|--output)(?=\s|=|$)/ },
  // curl: -o/-O (also inside a cluster such as -sSLo), --output,
  // --remote-name(-all), -J/--remote-header-name, --output-dir write files.
  { command: /^curl(?:\s|$)/, flags: /(?:^|\s)(?:-[A-Za-z]*[oOJ][A-Za-z]*|--output|--output-dir|--remote-name|--remote-name-all|--remote-header-name|--create-dirs)(?=\s|=|$)/ },
  // wget: -O/--output-document, -o/--output-file, -a/--append-output,
  // -P/--directory-prefix all choose where it writes.
  { command: /^wget(?:\s|$)/, flags: /(?:^|\s)(?:-[A-Za-z]*[oOaP][A-Za-z]*|--output-document|--output-file|--append-output|--directory-prefix)(?=\s|=|$)/ },
  // git log/diff: --output writes the result to a file; --ext-diff runs the
  // configured external diff program; --no-index diffs arbitrary paths;
  // --textconv runs configured conversion filters.
  { command: /^git\s+(?:log|diff|status|branch)(?:\s|$)/, flags: /(?:^|\s)(?:--output|--ext-diff|--no-index|--textconv)(?=\s|=|$)/ },
  // rg --pre CMD pipes every file through an arbitrary preprocessor.
  { command: /^rg(?:\s|$)/, flags: /(?:^|\s)--pre(?=\s|=|$)/ },
];

type ArgPolicy = (args: readonly string[]) => string | null;

const anyArgs: ArgPolicy = () => null;

/** git: only these read subcommands, and nothing before the subcommand (`-c`, `-C`, `--git-dir`, `--exec-path`). */
const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'branch']);

const GIT_BRANCH_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);

const gitPolicy: ArgPolicy = (args) => {
  const sub = args[0];
  if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not a read subcommand`.trim();
  if (sub === 'branch') {
    const rest = args.slice(1);
    // Listing only: every argument is an option (or the value of a listing
    // filter such as --contains), and none of them mutates.
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith('-')) {
        if (GIT_BRANCH_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      return 'git branch with a name creates or changes a branch';
    }
    if (rest.some((a) => /^-[A-Za-z]*[dDmMcCfu]/.test(a) && !a.startsWith('--'))) return 'git branch mutating flag';
    if (rest.some((a) => /^--(?:delete|move|copy|force|edit-description|set-upstream-to|set-upstream|unset-upstream|track|no-track|create-reflog|recurse-submodules)(?:=|$)/.test(a))) {
      return 'git branch mutating flag';
    }
  }
  return null;
};

/** rg: --pre runs a program (deny list); -z/--search-zip spawns decompressors found on PATH. */
const rgPolicy: ArgPolicy = (args) => {
  for (const a of args) {
    if (a === '--') break;
    if (a === '--search-zip' || a === '-z') return 'rg --search-zip runs external decompressors';
    if (/^-[A-Za-z]+$/.test(a) && a.includes('z')) return 'rg -z runs external decompressors';
    if (/^--pre-glob(?:=|$)/.test(a)) continue;
  }
  return null;
};

/** tree -R re-runs tree with `-o 00Tree.html` in every directory (writes). */
const treePolicy: ArgPolicy = (args) => {
  for (const a of args) {
    if (/^-[A-Za-z]*R[A-Za-z]*$/.test(a)) return 'tree -R writes 00Tree.html files';
  }
  return null;
};

/**
 * ps: positive allowlist. BSD `ps e` / macOS `ps -e` print every process's
 * ENVIRONMENT (API keys of sibling processes), so flag clusters may not
 * contain e/E; values after -o/-O/-p/-u/-U/-G/-t are field or id lists.
 */
const PS_VALUE_FLAGS = new Set(['-o', '-O', '-p', '-u', '-U', '-G', '-g', '-t', '--pid', '--user', '--format', '--sort']);
const psPolicy: ArgPolicy = (args) => {
  let expectValue = false;
  for (const a of args) {
    if (expectValue) {
      if (!/^[A-Za-z0-9,%_=:.+-]+$/.test(a)) return `ps value ${JSON.stringify(a)}`;
      expectValue = false;
      continue;
    }
    if (PS_VALUE_FLAGS.has(a)) { expectValue = true; continue; }
    if (/^\d[\d,]*$/.test(a)) continue;
    if (!/^-{0,1}[AaxuUlfjwrcmvTSdhLMnqH]+$/.test(a)) return `ps flag ${JSON.stringify(a)} is not on the read-only list`;
  }
  return null;
};

/** cd is handled in-process (it is a shell builtin): zero or one directory argument. */
const cdPolicy: ArgPolicy = (args) => (args.length <= 1 && !(args[0] ?? '').startsWith('-') ? null : 'cd takes one directory');

/**
 * The argv-lane allowlist: program name → argv policy. Windows entries are
 * real executables in System32 (`dir`/`type` are cmd.exe builtins and so are
 * not here — they go through the approval lane).
 */
export const ARGV_ALLOWLIST: Readonly<Record<string, ArgPolicy>> = Object.freeze({
  ls: anyArgs,
  cat: anyArgs,
  pwd: anyArgs,
  which: anyArgs,
  echo: anyArgs,
  head: anyArgs,
  tail: anyArgs,
  wc: anyArgs,
  find: anyArgs,
  grep: anyArgs,
  rg: rgPolicy,
  ps: psPolicy,
  df: anyArgs,
  du: anyArgs,
  uname: anyArgs,
  tree: treePolicy,
  git: gitPolicy,
  cd: cdPolicy,
  where: anyArgs,
  findstr: anyArgs,
  tasklist: anyArgs,
  systeminfo: anyArgs,
});

/** Programs that are shell builtins in the argv lane and run in-process. */
export const IN_PROCESS_BUILTINS: ReadonlySet<string> = new Set(['cd']);

export type ArgvVerdict =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/**
 * Pure policy verdict: tokenizes and checks the allowlist and argv policy.
 * Does not look at the file system (binary resolution is separate).
 */
export function evaluateArgvPolicy(command: string): ArgvVerdict {
  const tok = tokenizePosix(command.trim());
  if (!tok.ok) return tok;
  const argv = tok.argv;
  const program = argv[0];
  // A path (./ls, /tmp/ls) is never the allowlisted program.
  if (program.includes('/') || program.includes('\\')) return { ok: false, reason: 'argv[0] must be a bare program name' };
  const policy = Object.prototype.hasOwnProperty.call(ARGV_ALLOWLIST, program) ? ARGV_ALLOWLIST[program] : undefined;
  if (!policy) return { ok: false, reason: `${program} is not on the argv-lane allowlist` };

  const joined = argv.join(' ');
  for (const rule of SIDE_EFFECT_FLAGS) {
    if (rule.command.test(joined) && rule.flags.test(joined)) return { ok: false, reason: 'side-effect flag' };
  }
  // File-list indirection in any command (wc/du/sort/…): the paths live
  // inside the referenced file, invisible to the literal-path gate.
  if (argv.some((a) => /^--files0-from(?:=|$)/.test(a))) return { ok: false, reason: '--files0-from indirection' };

  const verdict = policy(argv.slice(1));
  if (verdict) return { ok: false, reason: verdict };
  return { ok: true, argv };
}

// ─── Pinned PATH and binary resolution ───────────────────────────────────────

/**
 * Directories the argv lane resolves binaries from, in order. System
 * directories plus the two standard package-manager prefixes (Homebrew on
 * Apple silicon and Intel). Never derived from `process.env.PATH`, so a
 * PATH entry injected by a project, a `.env`, or a skill cannot substitute a
 * binary (#103).
 */
export function pinnedSearchDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    return [join(systemRoot, 'System32'), join(programFiles, 'Git', 'cmd')];
  }
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'];
}

/** The pinned PATH string for spawned tools (`:`-joined on POSIX, `;` on Windows). */
export function pinnedPath(platform: NodeJS.Platform = process.platform): string {
  return pinnedSearchDirs(platform).join(platform === 'win32' ? ';' : ':');
}

function isTrustedExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') {
      accessSync(file, constants.X_OK);
      // A world-writable binary can be swapped by any local user.
      if ((st.mode & 0o002) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export type BinaryResolver = (program: string) => string | undefined;

/** Resolve a program name against the pinned directories (no PATH lookup). */
export function resolveFromDirs(program: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? [`${program}.exe`, `${program}.cmd`, program] : [program];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isTrustedExecutable(candidate)) {
        try { return realpathSync(candidate); } catch { return candidate; }
      }
    }
  }
  return undefined;
}

let pinnedTable: ReadonlyMap<string, string> | null = null;

/**
 * Resolve every allowlisted program once and freeze the table. Called at
 * startup (and lazily on first use); later PATH or file-system changes to
 * user-writable directories cannot redirect an allowlisted name.
 */
export function initPinnedBinaries(dirs: readonly string[] = pinnedSearchDirs()): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (const program of Object.keys(ARGV_ALLOWLIST)) {
    if (IN_PROCESS_BUILTINS.has(program)) continue;
    const abs = resolveFromDirs(program, dirs);
    if (abs) table.set(program, abs);
  }
  pinnedTable = table;
  return table;
}

/** Default resolver: the pinned table built once per process. */
export const pinnedBinary: BinaryResolver = (program) => {
  if (!pinnedTable) initPinnedBinaries();
  return pinnedTable!.get(program);
};

/** Test hook: replace (or with `null`, reset) the pinned table. */
export function setPinnedBinariesForTest(table: Record<string, string> | null): void {
  pinnedTable = table ? new Map(Object.entries(table)) : null;
}

// ─── Minimal environment ─────────────────────────────────────────────────────

/**
 * The environment handed to argv-lane children: the pinned PATH, identity
 * and locale basics, and pager/prompt suppression. No API keys, no tokens,
 * no `GIT_*`/`RIPGREP_CONFIG_PATH`/`LD_*`/`DYLD_*` from the parent.
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: pinnedPath(platform),
    HOME: source.HOME || homedir(),
    LANG: source.LANG || 'C.UTF-8',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  };
  for (const key of ['USER', 'LOGNAME', 'TMPDIR', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (source[key]) env[key] = source[key];
  }
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC', 'WINDIR']) {
      if (source[key]) env[key] = source[key];
    }
  }
  return env;
}

// ─── Execution plan ──────────────────────────────────────────────────────────

/**
 * Hardening inserted into git argv: never run a repository-configured
 * fsmonitor hook, pager, external diff or textconv filter. A cloned repo's
 * `.git/config` is attacker-controlled input for a read-only helper.
 */
function hardenGit(argv: string[]): string[] {
  const [, sub, ...rest] = argv;
  const pre = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager'];
  const post = sub === 'diff' || sub === 'log' ? ['--no-ext-diff', '--no-textconv'] : [];
  return [...pre, sub, ...post, ...rest];
}

export type ArgvPlan =
  | { kind: 'exec'; file: string; args: string[]; argv: string[] }
  | { kind: 'builtin'; argv: string[] };

/**
 * The argv-lane execution plan for a command, or null when it belongs in
 * the approval (shell) lane: policy rejects it, or its program is not
 * installed in a pinned directory.
 */
export function planArgvExecution(command: string, resolve: BinaryResolver = pinnedBinary): ArgvPlan | null {
  const verdict = evaluateArgvPolicy(command);
  if (!verdict.ok) return null;
  const argv = verdict.argv;
  if (IN_PROCESS_BUILTINS.has(argv[0])) return { kind: 'builtin', argv };
  const file = resolve(argv[0]);
  if (!file) return null;
  const args = argv[0] === 'git' ? hardenGit(argv) : argv.slice(1);
  return { kind: 'exec', file, args, argv };
}
