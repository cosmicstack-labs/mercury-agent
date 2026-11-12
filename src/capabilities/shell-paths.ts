/**
 * The files a shell command touches, read the way the shell reads it — for
 * the "is this inside the folders I may use?" gate (cwdOnly; every bot).
 *
 * The old scan took every whitespace-preceded "/token" as a file to WRITE,
 * which asked the owner about things that are not files at all:
 *   - the body of a heredoc (`cat > a.js << 'EOF' … // comment, /\s+/ …`)
 *     gave "/", "/*" and "/\s+";
 *   - a quoted path with a space ("…/opersource.fyi manger/README.md") was
 *     cut at the space;
 *   - `-o /dev/null` was a write to /dev/null;
 *   - `ls`, `find`, `cat` were writes.
 * Here: heredoc bodies are data, quotes are honoured, device files are
 * ignored, and each path is a read or a write by what the command does with
 * it (a redirect target or `-o file` is a write; `ls dir` is a read; a
 * command not known to be read-only keeps treating its paths as writes).
 */

export interface ShellPath { path: string; mode: 'read' | 'write' }

/** Commands that only read the paths they are given (unless redirected, or with a writing flag). */
const READ_ONLY = new Set(['ls', 'find', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'less', 'more',
  'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum', 'realpath', 'readlink', 'dirname', 'basename', 'test', '[', 'jq', 'sort', 'uniq', 'cut', 'awk',
  'sed', 'xxd', 'hexdump', 'strings', 'od', 'open', 'curl', 'wget', 'ping', 'echo', 'printf', 'sleep', 'which', 'type', 'pwd', 'date', 'git']);
/** Their first non-option argument is a pattern or script, not a file. */
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'jq']);
/** Flags that make an otherwise read-only command write (or run something). */
const WRITING_FLAGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/,
  sed: /^(-i\S*|--in-place\S*)$/,
  sort: /^(-o|--output\S*)$/,
  git: /^(push|commit|checkout|reset|clean|rm|mv|apply|am|merge|rebase|pull|clone|init|add|stash|restore|switch|tag|branch|worktree)$/,
};
/** Options whose value is a file the command writes, per command (`-o` is "or" to find). */
const OUTPUT_OPTION: Record<string, RegExp> = {
  curl: /^(-o|--output)$/,
  wget: /^(-O|--output-document|-o|--output-file|-a|--append-output)$/,
  sort: /^(-o|--output)$/,
};
const DEVICE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|fd\/\d+|random|urandom)$/;

/** Remove heredoc bodies: everything after `<<WORD` / `<<-'WORD'` up to the line that is WORD. */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let end: string | null = null;
  let dash = false;
  for (const line of lines) {
    if (end !== null) {
      if ((dash ? line.replace(/^\t+/, '') : line).trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(line);
    if (m) { end = m[3]; dash = m[1] === '-'; }
  }
  return out.join('\n');
}

/** Shell words of one segment: quotes joined and removed, backslash escapes kept as the character. */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) words.push(cur); cur = ''; has = false; continue; }
    // A redirect operator is its own word: `2>/dev/null` → "2>", "/dev/null".
    if (c === '>' || c === '<') {
      let op = c;
      while (segment[i + 1] === '>' || segment[i + 1] === '&') op += segment[++i];
      if (/^\d+$/.test(cur) || cur === '&') { op = cur + op; cur = ''; has = false; }
      if (has || cur) words.push(cur);
      words.push(op);
      cur = ''; has = false;
      continue;
    }
    cur += c; has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

const looksLikePath = (w: string) => w.startsWith('/') || w.startsWith('~/') || w === '~' || w.startsWith('../') || /^[A-Za-z]:\\/.test(w) || w.startsWith('\\\\');

/** The paths in one command segment (after stripHeredocs and segment splitting), each a read or a write. */
export function shellPaths(segment: string): ShellPath[] {
  const words = shellWords(segment);
  // Skip leading env assignments and wrappers ("FOO=1 sudo time cmd").
  let k = 0;
  while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || ['sudo', 'time', 'nice', 'nohup', 'env', 'command', 'exec'].includes(words[k]))) k++;
  const cmd = (words[k] ?? '').split('/').pop() ?? '';
  const readOnly = READ_ONLY.has(cmd) && !words.slice(k + 1).some((w) => WRITING_FLAGS[cmd]?.test(w));
  const out: ShellPath[] = [];
  // A program run by its path ("/opt/x/run.sh") touches that path.
  if (words[k] && looksLikePath(words[k])) out.push({ path: words[k], mode: 'write' });
  let patternSkipped = !PATTERN_FIRST.has(cmd);
  for (let i = k + 1; i < words.length; i++) {
    const w = words[i];
    if (/^\d*>{1,2}&?$|^&>{1,2}$/.test(w)) {
      const target = words[++i];
      if (target && !/^&?\d+$/.test(target) && !DEVICE.test(target)) out.push({ path: target, mode: 'write' });
      continue;
    }
    if (/^\d*<{1,3}$/.test(w)) { const src = words[++i]; if (src && looksLikePath(src) && !DEVICE.test(src)) out.push({ path: src, mode: 'read' }); continue; }
    if (OUTPUT_OPTION[cmd]?.test(w)) {
      const target = words[++i];
      if (target && !DEVICE.test(target) && target !== '-') out.push({ path: target, mode: 'write' });
      continue;
    }
    if (w.startsWith('-')) {
      // --output=/path
      const eq = OUTPUT_OPTION[cmd] ? /^--(output|output-document|output-file)=(.+)$/.exec(w) : null;
      if (eq && !DEVICE.test(eq[2])) out.push({ path: eq[2], mode: 'write' });
      continue;
    }
    if (!patternSkipped) { patternSkipped = true; continue; }
    if (!looksLikePath(w) || DEVICE.test(w)) continue;
    out.push({ path: w, mode: readOnly ? 'read' : 'write' });
  }
  return out;
}

/** Read-only and unable to run anything else or reach the network: safe to run when every path is readable. */
const QUIET_READERS = new Set(['ls', 'find', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'file', 'du', 'tree', 'diff', 'cmp',
  'md5', 'md5sum', 'shasum', 'sha256sum', 'realpath', 'readlink', 'dirname', 'basename', 'sort', 'uniq', 'cut', 'jq', 'echo', 'printf', 'pwd', 'date', 'test', '[', 'which']);

/**
 * A segment that only reads: a quiet reader, no writing flag, no output
 * redirect to a file, no command substitution. `2>/dev/null` is fine.
 */
export function isReadOnlySegment(segment: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(segment)) return false;
  const words = shellWords(segment);
  const cmd = (words[0] ?? '').split('/').pop() ?? '';
  if (!QUIET_READERS.has(cmd)) return false;
  if (words.slice(1).some((w) => WRITING_FLAGS[cmd]?.test(w))) return false;
  return shellPaths(segment).every((p) => p.mode === 'read');
}
