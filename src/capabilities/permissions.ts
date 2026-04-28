import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface FileScope {
  path: string;
  read: boolean;
  write: boolean;
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

export interface PermissionAskContext {
  channelId: string;
  channelType: string;
}

interface SessionPermissionsState {
  autoApproveAll: boolean;
  elevatedCommands: Set<string>;
  pendingApprovals: Set<string>;
  tempScopes: FileScope[];
  channelType: string;
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
      blocked: [
        'sudo *',
        'rm -rf /',
        'rm -rf ~',
        'rm -rf /*',
        'mkfs *',
        'dd if=*',
        'chmod 777 /',
        'chown * /',
        ':(){ :|:& };:',
        'shutdown *',
        'reboot *',
        'halt *',
        'init 0',
        'init 6',
        'kill -9 1',
        '> /dev/sda',
        'mv /* /dev/null',
        'del /s /q C:\\*',
        'rmdir /s /q C:\\*',
        'format *',
        'icacls * C:\\* /grant',
        'net user *',
        'netsh *',
        'reg delete *',
        'cmd /c rd /s /q *',
      ],
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

export class PermissionManager {
  private manifest: PermissionsManifest;
  private readonly cwd: string;
  private askHandler?: (prompt: string, context: PermissionAskContext) => Promise<string>;
  private readonly sessionStates: Map<string, SessionPermissionsState> = new Map();
  private currentChannelId = 'cli:default';

  constructor() {
    this.cwd = process.cwd();
    this.manifest = this.load();
    this.ensureSessionState(this.currentChannelId, 'cli');
  }

  setCurrentChannel(channelId: string, channelType: string): void {
    this.currentChannelId = channelId;
    this.ensureSessionState(channelId, channelType).channelType = channelType;
  }

  setCurrentChannelType(type: string): void {
    this.ensureCurrentSession().channelType = type;
  }

  getCurrentChannelType(): string {
    return this.ensureCurrentSession().channelType;
  }

  onAsk(handler: (prompt: string, context: PermissionAskContext) => Promise<string>): void {
    this.askHandler = handler;
  }

  setAutoApproveAll(value: boolean): void {
    this.ensureCurrentSession().autoApproveAll = value;
  }

  isAutoApproveAll(): boolean {
    return this.ensureCurrentSession().autoApproveAll;
  }

  elevateForSkill(allowedTools: string[]): void {
    const session = this.ensureCurrentSession();
    if (allowedTools.includes('run_command')) {
      session.elevatedCommands.add('run_command');
    }
    if (allowedTools.includes('read_file') || allowedTools.includes('list_dir')) {
      session.elevatedCommands.add('fs_read');
    }
    if (allowedTools.includes('write_file') || allowedTools.includes('create_file') || allowedTools.includes('delete_file')) {
      session.elevatedCommands.add('fs_write');
    }
  }

  clearElevation(): void {
    this.ensureCurrentSession().elevatedCommands.clear();
  }

  isElevated(tool: string): boolean {
    return this.ensureCurrentSession().elevatedCommands.has(tool);
  }

  isShellElevated(): boolean {
    return this.ensureCurrentSession().elevatedCommands.has('run_command');
  }

  addPendingApproval(baseCommand: string): void {
    this.ensureCurrentSession().pendingApprovals.add(baseCommand);
  }

  clearPendingApprovals(): void {
    this.ensureCurrentSession().pendingApprovals.clear();
  }

  private ensureCurrentSession(): SessionPermissionsState {
    return this.ensureSessionState(this.currentChannelId);
  }

  private ensureSessionState(channelId: string, channelType?: string): SessionPermissionsState {
    let session = this.sessionStates.get(channelId);
    if (!session) {
      session = {
        autoApproveAll: false,
        elevatedCommands: new Set<string>(),
        pendingApprovals: new Set<string>(),
        tempScopes: [],
        channelType: channelType ?? this.inferChannelType(channelId),
      };
      this.sessionStates.set(channelId, session);
    } else if (channelType) {
      session.channelType = channelType;
    }
    return session;
  }

  private inferChannelType(channelId: string): string {
    const [channelType] = channelId.split(':');
    return channelType || 'cli';
  }

  private getCurrentAskContext(): PermissionAskContext {
    const session = this.ensureCurrentSession();
    return {
      channelId: this.currentChannelId,
      channelType: session.channelType,
    };
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

  async checkFsAccess(path: string, mode: 'read' | 'write'): Promise<{ allowed: boolean; reason?: string }> {
    const session = this.ensureCurrentSession();

    if (mode === 'read' && session.elevatedCommands.has('fs_read')) {
      return { allowed: true };
    }
    if (mode === 'write' && session.elevatedCommands.has('fs_write')) {
      return { allowed: true };
    }

    const fs = this.manifest.capabilities.filesystem;
    if (!fs.enabled) {
      return { allowed: false, reason: 'Filesystem capability is disabled' };
    }

    const resolved = resolve(path);
    const scope = this.findScope(resolved);
    const tempScope = this.findTempScope(resolved);

    if (scope) {
      if (mode === 'read' && scope.read) return { allowed: true };
      if (mode === 'write' && scope.write) return { allowed: true };
      return { allowed: false, reason: `Permission denied: ${mode} access to ${path} (scope has ${mode}=false)` };
    }

    if (tempScope) {
      if (mode === 'read' && tempScope.read) return { allowed: true };
      if (mode === 'write' && tempScope.write) return { allowed: true };
      return { allowed: false, reason: `Permission denied: ${mode} access to ${path}` };
    }

    return { allowed: false, reason: `Permission denied for ${mode} access to ${path}` };
  }

  async checkShellCommand(command: string): Promise<{ allowed: boolean; reason?: string; needsApproval: boolean }> {
    const session = this.ensureCurrentSession();
    const shell = this.manifest.capabilities.shell;
    if (!shell.enabled) {
      return { allowed: false, reason: 'Shell capability is disabled', needsApproval: false };
    }

    const trimmed = command.trim();

    for (const pattern of shell.blocked) {
      if (this.matchPattern(trimmed, pattern)) {
        return { allowed: false, reason: `Blocked command: matches "${pattern}"`, needsApproval: false };
      }
    }

    if (shell.cwdOnly) {
      const hasPathTraversal = this.hasPathBeyondCwd(trimmed);
      if (hasPathTraversal) {
        const scopeCheck = await this.checkFsAccess(hasPathTraversal, 'write');
        if (!scopeCheck.allowed) {
          return { allowed: false, reason: `No permission to access ${hasPathTraversal}. Use approve_scope tool with path="${hasPathTraversal}" and mode="write" to request access.`, needsApproval: false };
        }
      }
    }

    if (session.autoApproveAll) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (auto-approve-all mode)');
      return { allowed: true, needsApproval: false };
    }

    if (this.isShellElevated()) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (skill elevation)');
      return { allowed: true, needsApproval: false };
    }

    const baseCmd = trimmed.split(/\s+/)[0];
    if (session.pendingApprovals.has(baseCmd)) {
      logger.info({ cmd: trimmed }, 'Shell command auto-approved (pending approval)');
      return { allowed: true, needsApproval: false };
    }

    for (const pattern of shell.autoApproved) {
      if (this.matchPattern(trimmed, pattern)) {
        logger.info({ cmd: trimmed }, 'Shell command auto-approved');
        return { allowed: true, needsApproval: false };
      }
    }

    for (const pattern of shell.needsApproval) {
      if (this.matchPattern(trimmed, pattern)) {
        if (session.channelType === 'telegram' && this.askHandler) {
          const result = await this.askHandler(`Run command: ${trimmed}`, this.getCurrentAskContext());
          if (result === 'yes') {
            return { allowed: true, needsApproval: false };
          }
          if (result === 'always') {
            this.addApprovedCommand(baseCmd);
            return { allowed: true, needsApproval: false };
          }
          return { allowed: false, reason: `User denied: ${trimmed}`, needsApproval: false };
        }
        return { allowed: false, reason: `Command requires approval: matches "${pattern}"`, needsApproval: true };
      }
    }

    if (session.channelType === 'telegram' && this.askHandler) {
      const result = await this.askHandler(`Run command: ${trimmed}`, this.getCurrentAskContext());
      if (result === 'yes') {
        return { allowed: true, needsApproval: false };
      }
      if (result === 'always') {
        this.addApprovedCommand(baseCmd);
        return { allowed: true, needsApproval: false };
      }
      return { allowed: false, reason: `User denied: ${trimmed}`, needsApproval: false };
    }

    return { allowed: false, reason: 'Command not in auto-approve list — requires approval', needsApproval: true };
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
    for (const scope of scopes) {
      const scopeResolved = resolve(scope.path.replace(/^~/, homedir()));
      if (resolvedPath === scopeResolved || resolvedPath.startsWith(scopeResolved + sep)) {
        return scope;
      }
    }
    return undefined;
  }

  async requestScopeExternal(path: string, mode: 'read' | 'write'): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.askHandler) {
      return { allowed: false, reason: `Permission denied for ${mode} access to ${path}` };
    }

    const prompt = `Mercury needs ${mode} access to:\n${path}\n\nAllow access?`;
    const response = await this.askHandler(prompt, this.getCurrentAskContext());

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

  addTempScope(path: string, read: boolean, write: boolean): void {
    const resolved = resolve(path);
    this.ensureCurrentSession().tempScopes.push({ path: resolved, read, write });
    logger.info({ path: resolved, read, write }, 'Temp permission scope added (session only)');
  }

  private findTempScope(resolvedPath: string): FileScope | undefined {
    for (const scope of this.ensureCurrentSession().tempScopes) {
      const scopeResolved = resolve(scope.path.replace(/^~/, homedir()));
      if (resolvedPath === scopeResolved || resolvedPath.startsWith(scopeResolved + sep)) {
        return scope;
      }
    }
    return undefined;
  }

  private matchPattern(command: string, pattern: string): boolean {
    const regexStr = '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try {
      return new RegExp(regexStr, 'i').test(command);
    } catch {
      return command.startsWith(pattern.replace(/ \*$/, ''));
    }
  }

  private hasPathBeyondCwd(command: string): string | null {
    const pathPatterns = [
      /(?:^|\s)(\/[^\s]+)/,
      /(?:^|\s)(~\/[^\s]+)/,
      /(?:^|\s)\.\.\/([^\s]+)/,
      /(?:^|\s)([A-Za-z]:\\[^\s]+)/,
      /(?:^|\s)(\\\\[^\s]+)/,
    ];
    for (const p of pathPatterns) {
      const match = command.match(p);
      if (match) {
        const candidate = resolve(match[1].replace(/^~/, homedir()));
        if (!candidate.startsWith(this.cwd)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private mergeDefaults(parsed: Partial<PermissionsManifest>): PermissionsManifest {
    return {
      capabilities: {
        filesystem: {
          enabled: parsed.capabilities?.filesystem?.enabled ?? DEFAULT_MANIFEST.capabilities.filesystem.enabled,
          scopes: parsed.capabilities?.filesystem?.scopes ?? DEFAULT_MANIFEST.capabilities.filesystem.scopes,
        },
        shell: {
          enabled: parsed.capabilities?.shell?.enabled ?? DEFAULT_MANIFEST.capabilities.shell.enabled,
          blocked: parsed.capabilities?.shell?.blocked ?? DEFAULT_MANIFEST.capabilities.shell.blocked,
          autoApproved: parsed.capabilities?.shell?.autoApproved ?? DEFAULT_MANIFEST.capabilities.shell.autoApproved,
          needsApproval: parsed.capabilities?.shell?.needsApproval ?? DEFAULT_MANIFEST.capabilities.shell.needsApproval,
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