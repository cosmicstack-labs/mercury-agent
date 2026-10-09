import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, sep, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { BLOCKED_COMMANDS } from './shell/blocklist.js';
import {
  evaluateArgvPolicy,
  pinnedBinary,
  IN_PROCESS_BUILTINS,
  type BinaryResolver,
} from './shell/argv-lane.js';
import {
  makeContext,
  withChanges,
  permissionContextStore,
  type PermissionContext,
  type ContextScope,
} from './permission-context.js';

export type { PermissionContext } from './permission-context.js';

/** Result of a shell permission check. */
export interface ShellCheckResult {
  allowed: boolean;
  reason?: string;
  needsApproval: boolean;
  /**
   * `argv`: auto-approved through the argv lane — the caller must execute
   * it with execFile (see planArgvExecution), never a shell. `shell`:
   * approved through the approval lane (prompt, allow-all, elevation, bot
   * grant) — the exact string the user saw may run through a shell.
   */
  lane?: 'argv' | 'shell';
}

/**
 * Command-pattern glob → anchored, case-insensitive RegExp. `*` matches any
 * text, `?` one character; everything else is literal. Regex metacharacters
 * are escaped so `C:\\*` means "C:\ then anything" (not "C: + any char"),
 * `curl * | sh` is one pattern (not an alternation), and `rm -rf .` matches
 * only a literal dot.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/([*?])/)
    .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.+^${}()|[\]\\\/]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

export interface FileScope {
  path: string;
  read: boolean;
  write: boolean;
  /**
   * Explicit execute grant (fail-closed bots): shell commands whose path
   * arguments all resolve inside this scope may run. The global
   * blocked-command list always wins; commands without path arguments stay
   * approval-gated.
   */
  execute?: boolean;
}

export interface ShellPermissions {
  enabled: boolean;
  blocked: string[];
  autoApproved: string[];
  needsApproval: string[];
  cwdOnly: boolean;
}

export interface FsPermissions {
  enabled: boolean;
  scopes: FileScope[];
}

export interface GitPermissions {
  enabled: boolean;
  autoApproveRead: boolean;
  approveWrite: boolean;
}

export interface PermissionsManifest {
  capabilities: {
    filesystem: FsPermissions;
    shell: ShellPermissions;
    git: GitPermissions;
  };
}

/** Device/inode pair identifying the file a read was authorised against. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface FsAccessResult {
  allowed: boolean;
  reason?: string;
  /**
   * Why a read was refused: `symlink-escape` (the canonical target lies
   * outside every readable scope), `hardlink` (nlink > 1 and no approval),
   * or `denied` (ordinary scope/user denial).
   */
  code?: 'symlink-escape' | 'hardlink' | 'denied';
  /**
   * Reads only: the canonical (realpath) target the check was made against.
   * Tools must open THIS path, never the lexical one, so a symlink swapped in
   * after the check cannot redirect the read.
   */
  canonical?: string;
  /**
   * Reads of existing files only: lstat identity of `canonical` at check
   * time. Tools compare it with `fstat` on the opened descriptor to defeat a
   * swap between check and open (TOCTOU).
   */
  fileId?: FileIdentity;
}

const DEFAULT_MANIFEST: PermissionsManifest = {
  capabilities: {
    filesystem: {
      enabled: true,
      scopes: [
        { path: '.', read: true, write: true },
      ],
    },
    shell: {
      enabled: true,
      // Single source of truth: shell/blocklist.ts (also carries the
      // PowerShell forms — Set-ExecutionPolicy, Remove-Item -Recurse roots).
      blocked: [...BLOCKED_COMMANDS],
      autoApproved: [
        'ls *',
        'cat *',
        'pwd',
        'which *',
        'node *',
        'npm run *',
        'npm test *',
        'npm list *',
        'git status *',
        'git diff *',
        'git log *',
        'git branch *',
        'echo *',
        'head *',
        'tail *',
        'wc *',
        'find *',
        'grep *',
        'rg *',
        'ps *',
        'df *',
        'du *',
        'uname *',
        'curl *',
        'wget *',
        'dir *',
        'type *',
        'cd *',
        'where *',
        'tree *',
        'findstr *',
        'tasklist *',
        'systeminfo *',
      ],
      needsApproval: [
        'npm publish *',
        'git push *',
        'docker *',
        'curl * | sh',
        'curl * | bash',
        'wget * | sh',
        'pip install *',
        'pip3 install *',
        'rm -r *',
        'rm -rf *',
        'mv *',
        'cp -r *',
        'chmod *',
        'mkdir *',
        'rmdir *',
        'xcopy *',
        'robocopy *',
        'del *',
        'rd /s *',
        'powershell *',
        'cmd /c *',
      ],
      cwdOnly: true,
    },
    git: {
      enabled: true,
      autoApproveRead: true,
      approveWrite: true,
    },
  },
};

const PERMISSIONS_FILE = join(getMercuryHome(), 'permissions.yaml');

// Split a command into shell-segment strings so each pipeline/chain/substitution
// is checked separately. Without this, a single auto-approved base command
// (e.g. "echo *") would auto-approve the entire string including chained
// or substituted destructive commands like `echo $(rm -rf ~)` or `ls; reboot`.
// We are deliberately conservative: any segment we cannot fully decompose
// is returned as-is so the regular pattern checks decide its fate.
export function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let single = false;
  let double = false;
  let backtick = false;

  const flush = () => {
    const seg = buf.trim();
    if (seg.length > 0) out.push(seg);
    buf = '';
  };

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (single) {
      buf += ch;
      if (ch === "'") single = false;
      i++;
      continue;
    }
    if (double) {
      if (ch === '\\' && next !== undefined) {
        buf += ch + next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        buf += ch;
        double = false;
        i++;
        continue;
      }
      // Inside double quotes, bash still expands $(...) and `...` —
      // pull them out as their own segments so a covering "echo *" can't
      // launder a substituted destructive command.
      if (ch === '$' && next === '(') {
        i += 2;
        let depth = 1;
        let inner = '';
        while (i < command.length && depth > 0) {
          const c = command[i];
          if (c === '(') depth++;
          else if (c === ')') { depth--; if (depth === 0) break; }
          inner += c;
          i++;
        }
        i++;
        for (const seg of splitShellSegments(inner)) out.push(seg);
        continue;
      }
      if (ch === '`') {
        i++;
        let inner = '';
        while (i < command.length && command[i] !== '`') {
          inner += command[i];
          i++;
        }
        i++;
        for (const seg of splitShellSegments(inner)) out.push(seg);
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (backtick) {
      if (ch === '`') {
        backtick = false;
        if (buf.trim().length > 0) {
          for (const inner of splitShellSegments(buf)) out.push(inner);
          buf = '';
        }
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "'") { single = true; buf += ch; i++; continue; }
    if (ch === '"') { double = true; buf += ch; i++; continue; }
    if (ch === '`') {
      flush();
      backtick = true;
      i++;
      continue;
    }

    if (ch === '$' && next === '(') {
      flush();
      i += 2;
      let depth = 1;
      let inner = '';
      while (i < command.length && depth > 0) {
        const c = command[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
        inner += c;
        i++;
      }
      i++;
      for (const seg of splitShellSegments(inner)) out.push(seg);
      continue;
    }

    // Subshell ( ... ) and brace block { ... ; } both execute their contents,
    // so treat the boundaries as segment breaks rather than opaque text.
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') { flush(); i++; continue; }

    if (ch === ';' || ch === '\n') { flush(); i++; continue; }
    if (ch === '|' && next === '|') { flush(); i += 2; continue; }
    if (ch === '&' && next === '&') { flush(); i += 2; continue; }
    if (ch === '|') { flush(); i++; continue; }
    if (ch === '&') { flush(); i++; continue; }

    buf += ch;
    i++;
  }

  flush();
  if (out.length === 0) out.push(command.trim());
  return out;
}

export class PermissionManager {
  private manifest: PermissionsManifest;
  private readonly cwd: string;
  private askHandler?: (prompt: string) => Promise<string>;
  /**
   * The main agent's (root) context: replaced, never mutated, by the
   * legacy setters below. Sub-agents never read it while they run — they
   * carry their own context through AsyncLocalStorage (`withContext`).
   */
  private session: PermissionContext = makeContext();
  /** Grant of the internal turn in progress (agent.ts), layered over `session`. */
  private turnGrant: { scopes: ContextScope[] } | null = null;
  private rootCache: PermissionContext | null = null;
  private binaryResolver: BinaryResolver = pinnedBinary;
  private approvedCommandsByContext = new Map<string, Set<string>>();
  private approvedWritesByContext = new Map<string, Set<string>>();
  /** Hard-linked files the user answered "always" for, per interaction context. */
  private approvedHardlinkReadsByContext = new Map<string, Set<string>>();
  /**
   * Fail-closed mode (unattended agents, e.g. Mercury Bots): no interactive
   * approvals exist. Explicitly granted scopes apply without prompting;
   * everything else denies. Never combined with autoApproveAll.
   */
  private failClosed = false;

  /**
   * Bot-scoped shell allow-list (fail-closed runtimes): patterns the bot's
   * permissions.yaml explicitly granted. Kept separate from the manifest's
   * autoApproved so an ambient global list (e.g. a user-approved "node *")
   * can never silently elevate an unattended context.
   */
  private botShellAllowList?: string[];

  constructor() {
    this.cwd = process.cwd();
    this.manifest = this.load();
  }

  setFailClosed(value: boolean): void {
    this.failClosed = value;
  }

  /**
   * Bot-only shell allow-list (fail-closed contexts): explicit grants from
   * the bot's permissions.yaml. A literal "*" is dropped — allow-all is an
   * interactive-mode concept, not a bot grant.
   */
  setBotShellAllowList(patterns: string[]): void {
    this.botShellAllowList = (patterns ?? [])
      .map(p => p.trim())
      .filter(p => p.length > 0 && p !== '*');
  }

  getBotShellAllowList(): string[] {
    return [...(this.botShellAllowList ?? [])];
  }

  isFailClosed(): boolean {
    return this.failClosed;
  }

  // ─── Permission context (ADR-016) ─────────────────────────────────────────

  /**
   * The context of the agent whose code is running: a sub-agent's own
   * context inside `withContext`, otherwise the main agent's root context
   * (session plus any internal-turn grant).
   */
  currentContext(): PermissionContext {
    const cell = permissionContextStore.getStore();
    if (cell && cell.owner === this) return cell.ctx;
    return this.rootContext();
  }

  private rootContext(): PermissionContext {
    if (this.rootCache) return this.rootCache;
    let ctx = this.session;
    if (this.turnGrant) {
      ctx = withChanges(ctx, {
        autoApprove: true,
        autoApproveOrigin: ctx.autoApprove ? ctx.autoApproveOrigin : 'turn',
        scopes: [...ctx.scopes, ...this.turnGrant.scopes],
      });
    }
    this.rootCache = ctx;
    return ctx;
  }

  private ctx(): PermissionContext {
    return this.currentContext();
  }

  /**
   * Replace the calling agent's context: its ALS cell when it is a
   * sub-agent, otherwise the root session. The patch is computed from that
   * base (never from the merged root, so a turn grant is not baked into
   * the session).
   */
  private updateContext(patch: (base: PermissionContext) => Partial<PermissionContext>): void {
    const cell = permissionContextStore.getStore();
    if (cell && cell.owner === this) {
      cell.ctx = withChanges(cell.ctx, patch(cell.ctx));
      return;
    }
    this.session = withChanges(this.session, patch(this.session));
    this.rootCache = null;
  }

  /**
   * Run `fn` (and everything it awaits or schedules) under `ctx`. Used for
   * sub-agents; their tools resolve permissions against `ctx` even while
   * the main agent's root context changes concurrently.
   */
  withContext<T>(ctx: PermissionContext, fn: () => T): T {
    return permissionContextStore.run({ owner: this, ctx: Object.isFrozen(ctx) ? ctx : makeContext(ctx) }, fn);
  }

  /**
   * Start the grant of one internal (scheduled/background) turn on the
   * root context: allow-all plus `scopes`, origin `turn`. Not visible to
   * sub-agents already running, and not inherited by ones spawned during
   * the turn. `endTurnGrant()` removes it and leaves the session (e.g. a
   * user's Allow All) untouched.
   */
  beginTurnGrant(grant: { scopes?: Array<{ path: string; read: boolean; write: boolean }> } = {}): void {
    this.turnGrant = { scopes: (grant.scopes ?? []).map((s) => ({ ...s, path: resolve(s.path) })) };
    this.rootCache = null;
  }

  endTurnGrant(): void {
    this.turnGrant = null;
    this.rootCache = null;
  }

  /** Test hook: resolve argv-lane binaries with `resolver` instead of the pinned table. */
  setBinaryResolver(resolver: BinaryResolver): void {
    this.binaryResolver = resolver;
  }

  // ─── Legacy setters (shims over the context) ──────────────────────────────

  setCurrentChannelType(type: string): void {
    this.updateContext(() => ({ channelType: type }));
  }

  setCurrentContext(type: string, id: string): void {
    this.updateContext(() => ({ channelType: type, channelId: id }));
  }

  getCurrentChannelType(): string {
    return this.ctx().channelType;
  }

  getCurrentChannelId(): string {
    return this.ctx().channelId;
  }

  setCurrentSenderRole(role: 'admin' | 'member' | undefined): void {
    this.updateContext(() => ({ senderRole: role }));
  }

  getCurrentSenderRole(): 'admin' | 'member' | undefined {
    return this.ctx().senderRole;
  }

  onAsk(handler: (prompt: string) => Promise<string>): void {
    this.askHandler = handler;
  }

  async requestApproval(prompt: string): Promise<boolean> {
    const ctx = this.ctx();
    // No one can answer on the internal channel: only an allow-all context
    // (the internal turn's own grant) approves; a child of it does not.
    if (ctx.channelType === 'internal') return ctx.autoApprove;
    if (!this.askHandler) return false;
    const result = await this.askHandler(prompt);
    return result === 'yes' || result === 'always';
  }

  /** Session-level Allow All (user choice). Inside a sub-agent it only changes that sub-agent. */
  setAutoApproveAll(value: boolean): void {
    this.updateContext(() => ({ autoApprove: value, autoApproveOrigin: value ? 'session' : null }));
  }

  isAutoApproveAll(): boolean {
    return this.ctx().autoApprove;
  }

  private isGlobalAutoApproveActive(): boolean {
    // Web/Cloud grants are resolved per session by WebChannel; a Local CLI
    // allow-all setting must never silently elevate remote requests.
    const ctx = this.ctx();
    return ctx.autoApprove && ctx.channelType !== 'web';
  }

  elevateForSkill(allowedTools: string[]): void {
    // Fail-closed mode (bots): skill elevation must never widen the granted
    // scopes — elevation is checked BEFORE the fail-closed gates in
    // checkFsAccess/checkShellCommand, so honoring it here would hand any
    // skill with allowed-tools an unrestricted bypass. Skills guide; they do
    // not re-permission.
    if (this.failClosed) {
      logger.info({ allowedTools }, 'Skill elevation ignored in fail-closed mode (granted scopes rule)');
      return;
    }
    const grants: string[] = [];
    if (allowedTools.includes('run_command')) grants.push('run_command');
    if (allowedTools.includes('read_file') || allowedTools.includes('list_dir')) grants.push('fs_read');
    if (allowedTools.includes('write_file') || allowedTools.includes('create_file') || allowedTools.includes('delete_file')) {
      grants.push('fs_write');
    }
    if (grants.length === 0) return;
    // Elevation lands on the calling agent's own context only.
    this.updateContext((base) => ({ elevated: [...new Set([...base.elevated, ...grants])] }));
  }

  clearElevation(): void {
    if (this.ctx().elevated.length === 0) return;
    this.updateContext(() => ({ elevated: [] }));
  }

  isElevated(tool: string): boolean {
    return this.ctx().elevated.includes(tool);
  }

  isShellElevated(): boolean {
    return this.isElevated('run_command');
  }

  private load(): PermissionsManifest {
    if (existsSync(PERMISSIONS_FILE)) {
      try {
        const raw = readFileSync(PERMISSIONS_FILE, 'utf-8');
        const parsed = parseYaml(raw) as PermissionsManifest;
        return this.mergeDefaults(parsed);
      } catch (err) {
        logger.warn({ err }, 'Failed to parse permissions.yaml, using defaults');
        return { ...DEFAULT_MANIFEST };
      }
    }
    this.save(DEFAULT_MANIFEST);
    return { ...DEFAULT_MANIFEST };
  }

  save(manifest?: PermissionsManifest): void {
    const m = manifest || this.manifest;
    const dir = getMercuryHome();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PERMISSIONS_FILE, stringifyYaml(m, { lineWidth: 0 }), 'utf-8');
    this.manifest = m;
  }

  getManifest(): PermissionsManifest {
    return this.manifest;
  }

  addApprovedCommand(baseCommand: string): void {
    const cmdName = baseCommand.trim().split(/\s+/)[0];
    const pattern = `${cmdName} *`;
    const shell = this.manifest.capabilities.shell;
    if (!shell.autoApproved.includes(pattern) && !shell.autoApproved.includes(cmdName)) {
      shell.autoApproved.push(pattern);
      this.save();
      logger.info({ pattern }, 'Shell command pattern auto-approved and saved');
    }
  }

  /**
   * Authorise a filesystem access. Writes: the lexical path must sit in a
   * writable scope and its canonical target must not escape (#105). Reads:
   * the same two conditions against readable scopes (an in-scope symlink to
   * `~/.ssh/id_rsa` is denied), plus a hard-link alias prompt (#104) and a
   * `canonical` + `fileId` the caller must verify at open time.
   *
   * Cost per read: one `realpath` and one `lstat`; nothing is cached across
   * calls, because the file system can change between them.
   */
  async checkFsAccess(path: string, mode: 'read' | 'write'): Promise<FsAccessResult> {
    if (mode === 'write') return this.checkScopedAccess(path, mode);

    const resolved = resolve(path);
    const canonical = this.canonicalizePath(resolved);

    // Skill elevation is an explicit "read anywhere" grant, so neither the
    // scope checks nor the alias prompt apply — but the caller still gets the
    // canonical path and identity so the open is verified like any other.
    if (this.isElevated('fs_read')) {
      return this.describeRead(canonical).result;
    }

    const fs = this.manifest.capabilities.filesystem;
    if (!fs.enabled) {
      return { allowed: false, reason: 'Filesystem capability is disabled', code: 'denied' };
    }

    const lexicallyReadable = this.isLexicallyReadable(resolved);
    if (lexicallyReadable && canonical !== resolved && !this.isWithinScope(canonical, 'read')) {
      // The lexical path is approved but it is a symlink (or sits under one)
      // whose target is not. Treat it exactly like a read of the target: ask
      // the user for the target when a prompt is possible, otherwise deny —
      // the model is told the canonical path so it can request that scope.
      const reason = `Permission denied: read of ${path} resolves outside the approved scopes (${canonical})`;
      if (!this.failClosed && !this.isGlobalAutoApproveActive() && this.askHandler && this.ctx().channelType !== 'internal') {
        const granted = await this.requestScopeExternal(canonical, 'read');
        if (!granted.allowed) return { allowed: false, reason, code: 'symlink-escape', canonical };
      } else {
        return { allowed: false, reason, code: 'symlink-escape', canonical };
      }
    } else if (!lexicallyReadable) {
      const scoped = await this.checkScopedAccess(path, mode);
      if (!scoped.allowed) return { ...scoped, code: 'denied', canonical };
      // A freshly approved scope covers the lexical path; the canonical
      // target must be covered too (an approval for a directory of symlinks
      // must not reach through them).
      if (canonical !== resolved && !this.isWithinScope(canonical, 'read')) {
        return {
          allowed: false,
          reason: `Permission denied: read of ${path} resolves outside the approved scopes (${canonical})`,
          code: 'symlink-escape',
          canonical,
        };
      }
    }

    return this.finishRead(path, canonical);
  }

  /** Lexical read check against the manifest and temp scopes. */
  private isLexicallyReadable(resolved: string): boolean {
    const scope = this.findScope(resolved);
    if (scope && scope.read) return true;
    const tempScope = this.findTempScope(resolved);
    return tempScope?.read === true;
  }

  /**
   * Post-scope read checks on the canonical target: a regular file with more
   * than one hard link may be an alias of a file outside every scope (the
   * inode carries no path, so the scope check cannot tell), so it goes
   * through the approval handler and is denied when nothing can ask (#104).
   */
  private async finishRead(path: string, canonical: string): Promise<FsAccessResult> {
    const described = this.describeRead(canonical);
    const nlink = described.nlink;
    if (nlink === undefined || nlink <= 1 || this.isGlobalAutoApproveActive()) return described.result;

    const channelId = this.ctx().channelId;
    const approvedAliases = this.approvedHardlinkReadsByContext.get(channelId);
    if (approvedAliases?.has(canonical)) return described.result;

    const reason = `Permission denied for read access to ${path}: the file has ${nlink} hard links and may alias a file outside the approved scopes`;
    if (this.failClosed || !this.askHandler || this.ctx().channelType === 'internal') {
      return { allowed: false, reason, code: 'hardlink', canonical };
    }
    const response = await this.askHandler(
      `Read hard-linked file: ${canonical}\n(${nlink} links — it may be an alias of a file outside the approved scopes)`,
    );
    if (response === 'always') {
      const approved = approvedAliases ?? new Set<string>();
      approved.add(canonical);
      this.approvedHardlinkReadsByContext.set(channelId, approved);
      return described.result;
    }
    if (response === 'yes') return described.result;
    return { allowed: false, reason: `User denied read of hard-linked file ${path}`, code: 'hardlink', canonical };
  }

  /** One lstat on the canonical target: identity for the open-time check plus the link count. */
  private describeRead(canonical: string): { result: FsAccessResult; nlink?: number } {
    try {
      const st = lstatSync(canonical);
      return {
        result: { allowed: true, canonical, fileId: { dev: st.dev, ino: st.ino } },
        nlink: st.isFile() ? st.nlink : undefined,
      };
    } catch {
      // Missing file: the tool reports "not found" itself.
      return { result: { allowed: true, canonical } };
    }
  }

  private async checkScopedAccess(path: string, mode: 'read' | 'write'): Promise<FsAccessResult> {
    if (mode === 'read' && this.isElevated('fs_read')) {
      return { allowed: true };
    }
    if (mode === 'write' && this.isElevated('fs_write')) {
      return { allowed: true };
    }

    const fs = this.manifest.capabilities.filesystem;
    if (!fs.enabled) {
      return { allowed: false, reason: 'Filesystem capability is disabled' };
    }

    const resolved = resolve(path);
    const scope = this.findScope(resolved);
    const tempScope = this.findTempScope(resolved);

    // A path that is lexically inside a scope can still leave it through a
    // symlink, because Node follows symlinks at the write sink. Reject writes
    // whose canonicalised target falls outside every writable scope.
    if (mode === 'write') {
      const canonical = this.canonicalizePath(resolved);
      if (canonical !== resolved && !this.isWithinScope(canonical, 'write')) {
        return {
          allowed: false,
          reason: `Permission denied: write to ${path} resolves outside the approved scopes (${canonical})`,
        };
      }
    }

    // Read access: allow if any scope covers it (reads are safe in any mode)
    if (mode === 'read') {
      if (scope && scope.read) return { allowed: true };
      if (tempScope && tempScope.read) return { allowed: true };
    }

    // Write access: in auto-approve-all mode, allow if scope covers it
    const channelId = this.ctx().channelId;
    const channelType = this.ctx().channelType;
    const contextWriteApproved = this.approvedWritesByContext.get(channelId)?.has(resolved) === true;
    if (mode === 'write' && (this.isGlobalAutoApproveActive() || contextWriteApproved)) {
      if (scope && scope.write) return { allowed: true };
      if (tempScope && tempScope.write) return { allowed: true };
    }

    // Fail-closed mode (bots): the explicitly granted scope IS the approval.
    // No prompting in either direction — in-scope writes run, out-of-scope
    // writes deny, and nothing ever waits for a user who isn't there.
    if (this.failClosed) {
      if (scope && scope.write) return { allowed: true };
      if (tempScope && tempScope.write) return { allowed: true };
      return { allowed: false, reason: `Fail-closed: no granted write scope covers ${path}` };
    }

    // Write access in ask-me mode: ALWAYS prompt the user, even if scope exists
    if (mode === 'write' && !this.isGlobalAutoApproveActive() && this.askHandler && channelType !== 'internal') {
      const scopeAllows = (scope && scope.write) || (tempScope && tempScope.write);
      if (scopeAllows) {
        // Scope allows it, but user wants to confirm — prompt with file path
        const result = await this.askHandler(`Write to file: ${resolved}`);
        if (result === 'yes') return { allowed: true };
        if (result === 'always') {
          const approved = this.approvedWritesByContext.get(channelId) ?? new Set<string>();
          approved.add(resolved);
          this.approvedWritesByContext.set(channelId, approved);
          return { allowed: true };
        }
        return { allowed: false, reason: `User denied write to ${path}` };
      }
      // No scope covers it — request scope expansion
      return this.requestScopeExternal(path, mode);
    }

    // No scope matched — deny or ask
    if (scope) {
      return { allowed: false, reason: `Permission denied: ${mode} access to ${path} (scope has ${mode}=false)` };
    }
    if (tempScope) {
      return { allowed: false, reason: `Permission denied: ${mode} access to ${path}` };
    }

    if (!this.isGlobalAutoApproveActive() && this.askHandler && channelType !== 'internal') {
      return this.requestScopeExternal(path, mode);
    }

    return { allowed: false, reason: `Permission denied for ${mode} access to ${path}` };
  }

  /**
   * Shell permission check. Two lanes (ADR-016):
   *
   * - **argv lane** (no prompt): the command tokenises into argv with no
   *   shell syntax, `argv[0]` is allowlisted, its flags pass the per-command
   *   policy, and every path argument stays inside the cwd or a readable
   *   scope. The caller executes it with execFile from the pinned PATH.
   * - **approval lane**: everything else, including pipelines and chains.
   *   The user sees the exact string; once approved it may use a shell.
   *
   * Hard blocks win over both, and Allow All / skill elevation / an
   * "always" answer / a bot allow-list grant approve through the approval
   * lane without prompting.
   */
  async checkShellCommand(command: string, options: { cwd?: string } = {}): Promise<ShellCheckResult> {
    const shell = this.manifest.capabilities.shell;
    if (!shell.enabled) {
      return { allowed: false, reason: 'Shell capability is disabled', needsApproval: false };
    }

    const trimmed = command.trim();
    const segments = splitShellSegments(trimmed);
    const ctx = this.ctx();
    const cwd = options.cwd ?? this.cwd;

    // Always block dangerous commands — check each segment so an
    // auto-approved base command can't launder a chained destructive one
    // (e.g. `echo *; rm -rf ~`).
    for (const segment of segments) {
      for (const pattern of shell.blocked) {
        if (this.matchPattern(segment, pattern)) {
          return { allowed: false, reason: `Blocked command: matches "${pattern}"`, needsApproval: false };
        }
      }
    }

    if (this.isGlobalAutoApproveActive()) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (Local allow-all mode)');
      return { allowed: true, needsApproval: false, lane: 'shell' };
    }

    if (this.isShellElevated()) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (skill elevation)');
      return { allowed: true, needsApproval: false, lane: 'shell' };
    }

    if (this.approvedCommandsByContext.get(ctx.channelId)?.has(trimmed)) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved for this interaction context');
      return { allowed: true, needsApproval: false, lane: 'shell' };
    }

    if (shell.cwdOnly) {
      for (const segment of segments) {
        const hasPathTraversal = this.hasPathBeyondCwd(segment);
        if (hasPathTraversal) {
          const scopeCheck = await this.checkFsAccess(hasPathTraversal, 'write');
          if (!scopeCheck.allowed && !this.isExecuteScoped(hasPathTraversal)) {
            return { allowed: false, reason: `No permission to access ${hasPathTraversal}. Use approve_scope tool with path="${hasPathTraversal}" and mode="write" to request access.`, needsApproval: false };
          }
        }
      }
    }

    // Bot allow-list (fail-closed only): set explicitly by the bot runtime
    // (registry-factory from permissions.yaml autoApproveCommands) — never
    // the ambient global autoApproved list, which stays decorative for
    // unattended contexts. Placement AFTER the cwd-containment gate means a
    // broad pattern like "cat *" can never launder a path outside granted
    // scopes; needsApproval wins (the same pattern in both lists means
    // deny); a bare "*" is rejected at grant time — allow-all is an
    // interactive-mode concept, not a bot grant. Read-only commands stay
    // covered by the argv lane below.
    if (this.failClosed && this.botShellAllowList && this.botShellAllowList.length > 0) {
      const needsApprovalList = shell.needsApproval ?? [];
      const botList = this.botShellAllowList;
      const allSegmentsApproved = segments.every((segment) =>
        botList.some((pattern) =>
          pattern.trim() !== '*' && this.matchPattern(segment, pattern)
        )
        && !needsApprovalList.some((pattern) => this.matchPattern(segment, pattern))
      );
      if (allSegmentsApproved) {
        logger.info({ cmd: trimmed }, 'Shell command auto-approved (bot allow-list)');
        return { allowed: true, needsApproval: false, lane: 'shell' };
      }
    }

    // Argv lane: the only path to a prompt-free approval in Ask Me mode.
    const argvLane = this.classifyArgvLane(trimmed, cwd);
    if (argvLane.ok) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (argv lane)');
      return { allowed: true, needsApproval: false, lane: 'argv' };
    }

    // Fail-closed execute grants (bots): an explicitly granted execute scope
    // lets the bot run commands whose path arguments ALL live inside it — the
    // blocked list already won above. Commands with no path argument stay
    // approval-gated: an unscoped `npm install` mutates cwd and can reach
    // anywhere via the network, so it is not covered by a directory grant.
    if (this.failClosed) {
      const pathTokens = segments.flatMap(s => this.extractPathTokens(s));
      if (pathTokens.length > 0 && pathTokens.every(t => this.isExecuteScoped(t))) {
        logger.info({ cmd: trimmed, paths: pathTokens.length }, 'Shell command allowed by execute scope');
        return { allowed: true, needsApproval: false, lane: 'shell' };
      }
    }

    // Approval lane: the user sees the exact string.
    if (this.askHandler && ctx.channelType !== 'internal') {
      const result = await this.askHandler(`Run command: ${trimmed}`);
      if (result === 'yes') {
        return { allowed: true, needsApproval: false, lane: 'shell' };
      }
      if (result === 'always') {
        const approved = this.approvedCommandsByContext.get(ctx.channelId) ?? new Set<string>();
        approved.add(trimmed);
        this.approvedCommandsByContext.set(ctx.channelId, approved);
        return { allowed: true, needsApproval: false, lane: 'shell' };
      }
      return { allowed: false, reason: `User denied: ${trimmed}`, needsApproval: false };
    }

    return { allowed: false, reason: 'Command not in auto-approve list — requires approval', needsApproval: true };
  }

  /**
   * Argv-lane classification: policy (tokenizer, allowlist, flag policy),
   * binary availability in the pinned PATH, and a path gate over the
   * tokenised arguments (after quote removal, so `cat "/etc/passwd"` is
   * seen as the absolute path it is).
   */
  classifyArgvLane(command: string, cwd: string = this.cwd): { ok: true; argv: string[] } | { ok: false; reason: string } {
    const verdict = evaluateArgvPolicy(command);
    if (!verdict.ok) return verdict;
    const argv = verdict.argv;
    if (!IN_PROCESS_BUILTINS.has(argv[0]) && !this.binaryResolver(argv[0])) {
      return { ok: false, reason: `${argv[0]} is not installed in the pinned system PATH` };
    }
    for (const arg of argv.slice(1)) {
      for (const candidate of this.argvPathCandidates(arg)) {
        const resolved = resolve(cwd, candidate.replace(/^~/, homedir()));
        if (resolved === cwd || resolved.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) continue;
        if (this.isLexicallyReadable(resolved)) continue;
        return { ok: false, reason: `path ${candidate} is outside the working directory and readable scopes` };
      }
    }
    return { ok: true, argv };
  }

  /** Path-like parts of one argv element: the element itself and an `--opt=value` value. */
  private argvPathCandidates(arg: string): string[] {
    const parts = [arg];
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0) parts.push(arg.slice(eq + 1));
    return parts.filter((p) =>
      p.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(p)
      || p.startsWith('\\\\')
      || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p),
    );
  }

  isGitReadAllowed(): boolean {
    return this.manifest.capabilities.git.enabled && this.manifest.capabilities.git.autoApproveRead;
  }

  isGitWriteNeedsApproval(): boolean {
    return this.manifest.capabilities.git.enabled && this.manifest.capabilities.git.approveWrite;
  }

  addScope(path: string, read: boolean, write: boolean): void {
    const resolved = resolve(path);
    const existing = this.findScope(resolved);
    if (existing) {
      existing.read = existing.read || read;
      existing.write = existing.write || write;
    } else {
      this.manifest.capabilities.filesystem.scopes.push({
        path: resolved,
        read,
        write,
      });
    }
    this.save();
    logger.info({ path: resolved, read, write }, 'Permission scope added');
  }

  private findScope(resolvedPath: string): FileScope | undefined {
    const scopes = this.manifest.capabilities.filesystem.scopes;
    // Most-specific scope wins: a deep grant (e.g. ~/.mercury/tam rwx) must
    // not be shadowed by a broad read-only ancestor (e.g. ~/.mercury r).
    let best: FileScope | undefined;
    let bestLen = -1;
    for (const scope of scopes) {
      const scopeResolved = resolve(scope.path.replace(/^~/, homedir()));
      if (resolvedPath === scopeResolved || resolvedPath.startsWith(scopeResolved + sep)) {
        if (scopeResolved.length > bestLen) {
          best = scope;
          bestLen = scopeResolved.length;
        }
      }
    }
    return best;
  }

  async requestScopeExternal(path: string, mode: 'read' | 'write'): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.askHandler) {
      return { allowed: false, reason: `Permission denied for ${mode} access to ${path}` };
    }

    const prompt = `Mercury needs ${mode} access to:\n${path}\n\nAllow access?`;
    const response = await this.askHandler(prompt);

    if (response === 'always') {
      this.addScope(path, mode === 'read', mode === 'write');
      return { allowed: true };
    }

    if (response === 'yes') {
      this.addTempScope(path, mode === 'read', mode === 'write');
      return { allowed: true };
    }

    return { allowed: false, reason: `Permission denied for ${mode} access to ${path}` };
  }

  /**
   * Session-only scope on the calling agent's context (the main agent's
   * session, or a sub-agent's own context — never shared with siblings).
   */
  addTempScope(path: string, read: boolean, write: boolean): void {
    const resolved = resolve(path);
    this.updateContext((base) => ({ scopes: [...base.scopes, { path: resolved, read, write }] }));
    logger.info({ path: resolved, read, write }, 'Temp permission scope added (session only)');
  }

  private findTempScope(resolvedPath: string): ContextScope | undefined {
    for (const scope of this.ctx().scopes) {
      const scopeResolved = resolve(scope.path.replace(/^~/, homedir()));
      if (resolvedPath === scopeResolved || resolvedPath.startsWith(scopeResolved + sep)) {
        return scope;
      }
    }
    return undefined;
  }

  /**
   * Canonicalise a path by resolving symlinks, tolerating paths that do not
   * exist yet (e.g. create_file): the deepest existing ancestor is resolved
   * and the remaining tail re-appended.
   */
  private canonicalizePath(resolved: string): string {
    try {
      return realpathSync(resolved);
    } catch {
      const parent = dirname(resolved);
      if (parent === resolved) return resolved;
      return join(this.canonicalizePath(parent), basename(resolved));
    }
  }

  /**
   * True when a canonical path falls inside a scope granting `mode`. Scope
   * bases are canonicalised too so a scope declared through a symlinked
   * directory (macOS `/tmp` → `/private/tmp`) still covers its own files.
   */
  private isWithinScope(canonicalPath: string, mode: 'read' | 'write'): boolean {
    const granting = [...this.manifest.capabilities.filesystem.scopes, ...this.ctx().scopes].filter(
      (scope) => (mode === 'write' ? scope.write : scope.read),
    );
    for (const scope of granting) {
      const base = this.canonicalizePath(resolve(scope.path.replace(/^~/, homedir())));
      if (canonicalPath === base || canonicalPath.startsWith(base + sep)) {
        return true;
      }
    }
    return false;
  }

  private matchPattern(command: string, pattern: string): boolean {
    try {
      return globToRegExp(pattern).test(command);
    } catch {
      return command.startsWith(pattern.replace(/ \*$/, ''));
    }
  }

  private static readonly PATH_PATTERNS = [
    /(?:^|\s)(\/[^\s]+)/,
    /(?:^|\s)(~\/[^\s]+)/,
    /(?:^|\s)\.\.\/([^\s]+)/,
    /(?:^|\s)([A-Za-z]:\\[^\s]+)/,
    /(?:^|\s)(\\\\[^\s]+)/,
  ];

  /** Every path-like token in a command segment, resolved (tilde expanded). */
  private extractPathTokens(text: string): string[] {
    const out: string[] = [];
    for (const pattern of PermissionManager.PATH_PATTERNS) {
      for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
        out.push(resolve(match[1].replace(/^~/, homedir())));
      }
    }
    return out;
  }

  /** A resolved path is covered by an explicit execute grant. */
  private isExecuteScoped(resolvedPath: string): boolean {
    if (this.findScope(resolvedPath)?.execute) return true;
    return this.findTempScope(resolvedPath)?.execute === true;
  }

  private hasPathBeyondCwd(command: string): string | null {
    for (const candidate of this.extractPathTokens(command)) {
      if (!candidate.startsWith(this.cwd)) return candidate;
    }
    return null;
  }

  private mergeDefaults(parsed: Partial<PermissionsManifest>): PermissionsManifest {
    const mergeArray = (existing: string[] | undefined, defaults: string[]): string[] => {
      if (!existing) return [...defaults];
      const combined = new Set([...defaults, ...existing]);
      return [...combined];
    };

    return {
      capabilities: {
        filesystem: {
          enabled: parsed.capabilities?.filesystem?.enabled ?? DEFAULT_MANIFEST.capabilities.filesystem.enabled,
          scopes: parsed.capabilities?.filesystem?.scopes ?? DEFAULT_MANIFEST.capabilities.filesystem.scopes,
        },
        shell: {
          enabled: parsed.capabilities?.shell?.enabled ?? DEFAULT_MANIFEST.capabilities.shell.enabled,
          blocked: mergeArray(parsed.capabilities?.shell?.blocked, DEFAULT_MANIFEST.capabilities.shell.blocked),
          autoApproved: mergeArray(parsed.capabilities?.shell?.autoApproved, DEFAULT_MANIFEST.capabilities.shell.autoApproved),
          needsApproval: mergeArray(parsed.capabilities?.shell?.needsApproval, DEFAULT_MANIFEST.capabilities.shell.needsApproval),
          cwdOnly: parsed.capabilities?.shell?.cwdOnly ?? DEFAULT_MANIFEST.capabilities.shell.cwdOnly,
        },
        git: {
          enabled: parsed.capabilities?.git?.enabled ?? DEFAULT_MANIFEST.capabilities.git.enabled,
          autoApproveRead: parsed.capabilities?.git?.autoApproveRead ?? DEFAULT_MANIFEST.capabilities.git.autoApproveRead,
          approveWrite: parsed.capabilities?.git?.approveWrite ?? DEFAULT_MANIFEST.capabilities.git.approveWrite,
        },
      },
    };
  }
}
