/**
 * Auto mode for bots (ADR-047): a bot never waits for the owner.
 *
 * Bots run unattended, so an ask outside a bot's grants is decided here at
 * once instead of waiting minutes for an answer that usually never comes.
 * The rule is reversibility:
 *
 *  - Anything that can be undone goes ahead: reading ordinary files, writing
 *    files (an existing file is backed up first, so the overwrite can be
 *    undone), running everyday commands, posting or sending through tools
 *    whose result can be deleted.
 *  - Anything that can't be undone is refused: deleting, force-pushing,
 *    discarding changes, publishing packages, sending email, dropping data,
 *    killing processes, running downloaded code, touching credentials or
 *    system files, and anything the prompt-injection guard (ADR-044) flags.
 *  - Anything this module doesn't recognise is refused: unknown is not safe.
 *
 * The global blocked list, the tool gate (permission tier) and the injection
 * scanner all still run first; this only answers what would have asked.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { splitShellSegments } from '../capabilities/permissions.js';

export type BotApprovalMode = 'auto' | 'ask';

/** The bot's own setting, else the fleet's; auto unless someone chose ask. */
export function botApprovalMode(
  manifest: { autonomy?: { approvals?: BotApprovalMode } },
  config: { bots?: { approvals?: BotApprovalMode } },
): BotApprovalMode {
  return manifest.autonomy?.approvals ?? config.bots?.approvals ?? 'auto';
}

export interface AutoDecision {
  answer: 'yes' | 'no';
  /** One line for the bot's activity and the audit log. */
  reason: string;
  /** Where an existing file was copied before an approved overwrite. */
  backup?: string;
}

export interface AutoContext {
  /** The bot's working directory: relative paths in commands resolve here. */
  cwd: string;
  /** Where overwritten files are copied first (per bot). */
  backupDir: string;
  home?: string;
  now?: number;
}

/** Overwrites of files larger than this can't be backed up cheaply, so they are refused. */
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
/** Backups older than this are pruned when a new one is made. */
const BACKUP_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const yes = (reason: string, backup?: string): AutoDecision => ({ answer: 'yes', reason, ...(backup ? { backup } : {}) });
const no = (reason: string): AutoDecision => ({ answer: 'no', reason });

// ---- paths ------------------------------------------------------------------

/** Secrets: never read or written by a bot, whatever its grants asked for. */
function isSecretPath(p: string, home: string): boolean {
  const rel = p.startsWith(home + '/') ? p.slice(home.length + 1) : null;
  if (rel !== null && /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/(gh|gcloud|op)|Library\/Keychains|Library\/Cookies)(\/|$)/.test(rel)) return true;
  if (rel !== null && /^\.mercury\/(\.env|mercury\.yaml|permissions\.yaml|devices\.json|auth|secrets?)/.test(rel)) return true;
  if (/\/(Cookies|Login Data|Web Data)(-journal)?$/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) return true;
  if (/^(\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(\.json)?|id_(rsa|ed25519|ecdsa|dsa))$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|kdbx)$/.test(base)) return true;
  return false;
}

/** Places a bot must not write: the system, and files that run code at login or on a schedule. */
function isUnsafeWritePath(p: string, home: string): boolean {
  if (!p.startsWith(home + '/')) return !p.startsWith('/tmp/') && !p.startsWith('/private/tmp/') && !p.startsWith('/var/folders/');
  const rel = p.slice(home.length + 1);
  if (/^\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile|login)$/.test(rel)) return true;
  if (/^(Library\/LaunchAgents|\.config\/autostart|\.config\/systemd)(\/|$)/.test(rel)) return true;
  if (/^\.git\/hooks\//.test(rel) || /\/\.git\/(hooks|config)(\/|$)/.test(p)) return true;
  return false;
}

function backupExisting(path: string, ctx: AutoContext): { ok: true; backup?: string } | { ok: false; reason: string } {
  let st;
  try { st = statSync(path); } catch { return { ok: true }; } // new file: nothing to lose
  if (!st.isFile()) return { ok: true };
  if (st.size > MAX_BACKUP_BYTES) return { ok: false, reason: `overwriting ${path} (${Math.round(st.size / 1048576)} MB) can't be undone: too large to back up` };
  const now = ctx.now ?? Date.now();
  pruneBackups(ctx.backupDir, now);
  const dest = join(ctx.backupDir, String(now), path.replace(/^\/+/, ''));
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(path, dest);
  } catch (err) {
    return { ok: false, reason: `couldn't back up ${path} before overwriting it (${(err as Error).message})` };
  }
  return { ok: true, backup: dest };
}

function pruneBackups(dir: string, now: number): void {
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      const at = Number(name);
      if (Number.isFinite(at) && now - at > BACKUP_KEEP_MS) rmSync(join(dir, name), { recursive: true, force: true });
    }
  } catch { /* pruning is best effort */ }
}

function decidePath(mode: 'read' | 'write', raw: string, ctx: AutoContext): AutoDecision {
  const home = ctx.home ?? homedir();
  const path = resolve(ctx.cwd, raw.replace(/^~(?=\/|$)/, home));
  if (isSecretPath(path, home)) return no(`${path} holds credentials`);
  if (mode === 'read') return yes(`reading ${path}`);
  if (isUnsafeWritePath(path, home)) return no(`${path} is a system or start-up file`);
  const backup = backupExisting(path, ctx);
  if (!backup.ok) return no(backup.reason);
  return yes(backup.backup ? `writing ${path} (previous version backed up)` : `writing ${path}`, backup.backup);
}

// ---- commands ---------------------------------------------------------------

/** Unquoted words of a segment, for subcommand checks (quoted text is data, not a verb). */
function words(segment: string): string[] {
  return segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ').split(/\s+/).filter(Boolean);
}

/** The argument after -c / -e for an interpreter, unquoted. */
function inlineCode(segment: string): string | null {
  const m = /^\s*(?:\S*\/)?(python3?|node|deno|bun|perl|ruby|php|bash|sh|zsh|osascript)\b.*?\s-(?:c|e|-eval)\s+(['"])([\s\S]*)\2\s*$/.exec(segment);
  return m ? m[3] : null;
}

const VERBS_NEVER = /^(sudo|doas|su|rm|rmdir|unlink|shred|srm|wipe|dd|mkfs(\..*)?|fdisk|diskutil|kill|pkill|killall|launchctl|crontab|chflags|sendmail|mail|mailx|mutt|passwd|chsh|visudo|security|csrutil|nvram|systemctl|service)$/;
const SUBCOMMANDS_NEVER = /^(delete|destroy|prune|purge|wipe|erase|drop|rmi|rb|truncate|--delete|-delete|delete-.+|terminate.*|deregister.*)$/;
const PUBLISH = /^(npm|yarn|pnpm|bun|cargo|gem|twine|poetry|flit|dotnet|mvn|gradle|vsce|ovsx)$/;
const DESTRUCTIVE_CODE = /\b(rmtree|rmSync|rmdirSync|unlinkSync|unlink|os\.remove|os\.rmdir|shutil\.move|File\.delete|FileUtils\.rm|rm\s+-|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM|child_process|subprocess|os\.system|exec\()/i;

/** Why this one command segment can't be undone, or null when it can. */
function irreversibleSegment(segment: string, ctx: AutoContext): string | null {
  const w = words(segment);
  if (w.length === 0) return null;
  // Strip env assignments and `env`/`command`/`nohup` prefixes.
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || /^(env|command|nohup|time|nice)$/.test(w[0]))) w.shift();
  const verb = (w[0] ?? '').replace(/^.*\//, '');
  if (!verb) return null;
  if (VERBS_NEVER.test(verb)) return `${verb} can't be undone`;
  if (verb === 'find' && w.some((x) => x === '-delete' || x === '-exec' || x === '-execdir' || x === '-ok')) return 'find with -delete/-exec can delete files';
  if (verb === 'xargs' && w.slice(1).some((x) => VERBS_NEVER.test(x.replace(/^.*\//, '')))) return 'xargs runs a destructive command';
  if (verb === 'git') {
    const sub = w.slice(1).find((x) => !x.startsWith('-')) ?? '';
    const rest = w.slice(1);
    if (sub === 'push' && rest.some((x) => /^(-f|--force.*|--mirror|--delete|-d|--prune)$/.test(x) || /^\+|^:/.test(x))) return 'force-pushing or deleting remote branches can\'t be undone';
    if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard discards work';
    if (sub === 'clean') return 'git clean deletes untracked files';
    if ((sub === 'checkout' || sub === 'restore') && (rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force'))) return 'this discards uncommitted changes';
    if (sub === 'branch' && rest.some((x) => x === '-D' || x === '--delete' || x === '-d')) return 'deleting a branch';
    if (sub === 'stash' && rest.some((x) => x === 'drop' || x === 'clear')) return 'dropping stashes';
    if (sub === 'tag' && rest.some((x) => x === '-d' || x === '--delete')) return 'deleting tags';
    if (sub === 'filter-branch' || sub === 'filter-repo' || sub === 'gc' || (sub === 'reflog' && rest.includes('expire'))) return `git ${sub} rewrites or drops history`;
    return null;
  }
  if (PUBLISH.test(verb) && w.slice(1).some((x) => /^(publish|unpublish|push|upload|deploy|release)$/.test(x))) return `publishing with ${verb} can't be taken back`;
  if (verb === 'gh' && w.slice(1).some((x) => /^(delete|archive|transfer)$/.test(x))) return 'deleting or transferring on GitHub';
  if ((verb === 'curl' || verb === 'wget' || verb === 'http' || verb === 'xh') && w.some((x, i) => /^(-X|--request|--method)$/.test(x) && /^DELETE$/i.test(w[i + 1] ?? '') || /^-XDELETE$/i.test(x) || /^DELETE$/.test(x))) return 'an HTTP DELETE';
  if (w.slice(1).some((x) => SUBCOMMANDS_NEVER.test(x))) return `"${w.slice(1).find((x) => SUBCOMMANDS_NEVER.test(x))}" deletes or destroys`;
  if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|USER)|TRUNCATE\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP)\b/i.test(segment)) return 'it deletes database data';
  if ((verb === 'chmod' || verb === 'chown' || verb === 'chgrp') && w.some((x) => /^-[a-zA-Z]*R/.test(x))) return 'recursive permission changes';
  const code = inlineCode(segment);
  if (code !== null) {
    if (/^(bash|sh|zsh)$/.test(verb)) return irreversibleCommand(code, ctx);
    if (DESTRUCTIVE_CODE.test(code)) return 'inline code that deletes files or runs other commands';
  }
  // Overwrites: a `>` redirect, or mv/cp onto a file that already exists, lose
  // its contents — back the file up first so it can be restored.
  const targets: string[] = [];
  for (const m of segment.matchAll(/(?<![>&0-9])>(?!>)\s*([^\s|;&<>]+)/g)) targets.push(m[1]);
  if ((verb === 'mv' || verb === 'cp') && w.length >= 3 && !w.some((x) => /^-[a-zA-Z]*t/.test(x))) targets.push(w[w.length - 1]);
  for (const t of targets) {
    if (t === '/dev/null' || t.startsWith('&')) continue;
    const decision = decidePath('write', t.replace(/^['"]|['"]$/g, ''), ctx);
    if (decision.answer === 'no') return decision.reason;
  }
  return null;
}

/** Why this command line can't be undone, or null when every part of it can. */
function irreversibleCommand(command: string, ctx: AutoContext): string | null {
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(command)) return 'it runs downloaded code';
  if (/\beval\b/.test(command)) return 'eval runs code that can\'t be checked first';
  for (const segment of splitShellSegments(command)) {
    const why = irreversibleSegment(segment, ctx);
    if (why) return why;
  }
  return null;
}

// ---- the injection guard's asks (ADR-044) -----------------------------------

/** Tools whose effect can't be undone, or that widen what the bot may do. */
const TOOLS_NEVER = new Set([
  'delete_file', 'forget_memory', 'install_skill', 'create_skill', 'approve_scope', 'approve_command',
  'bot_retire', 'cancel_scheduled_call',
]);

function decideGuard(prompt: string): AutoDecision {
  if (prompt.startsWith('⚠ Possible prompt injection')) return no('content it read contains instructions to an AI');
  if (prompt.includes('⚠ This could send data out')) return no('it would send data it read out of this machine');
  const tool = /It now wants to run (\S+) with:/.exec(prompt)?.[1];
  if (!tool) return no('unrecognised request');
  if (TOOLS_NEVER.has(tool)) return no(`${tool} can't be undone or widens the bot's access`);
  if (tool === 'git_push' && /\bforce\b["']?\s*:\s*true|--force/.test(prompt)) return no('force-pushing can\'t be undone');
  return yes(`${tool} after reading outside content (no hidden instructions found)`);
}

// ---- entry ------------------------------------------------------------------

/**
 * Decide an ask a bot would have sent to the owner. `prompt` is exactly what
 * PermissionManager / the injection guard would have shown the owner.
 */
export function decideBotApproval(prompt: string, ctx: AutoContext): AutoDecision {
  const text = prompt.trim();
  const cmd = /^Run command: ([\s\S]+)$/.exec(text);
  if (cmd) {
    const why = irreversibleCommand(cmd[1].trim(), ctx);
    return why ? no(why) : yes(`running ${cmd[1].trim().slice(0, 120)}`);
  }
  const file = /^(Write to file|Read file): (.+)$/.exec(text);
  if (file) return decidePath(file[1] === 'Write to file' ? 'write' : 'read', file[2].trim(), ctx);
  const scope = /^Mercury needs (read|write) access to:\n(.+)\n/.exec(text);
  if (scope) return decidePath(scope[1] as 'read' | 'write', scope[2].trim(), ctx);
  // The injection guard's ask. A command or file write it lets through still
  // meets the shell and path checks above on its way to running.
  if (text.startsWith('⚠ Possible prompt injection') || text.startsWith('Mercury read content from outside')) return decideGuard(text);
  return no('a request auto mode doesn\'t recognise');
}

/** Exposed for tests. */
export const __test = { isSecretPath, isUnsafeWritePath, irreversibleCommand };
