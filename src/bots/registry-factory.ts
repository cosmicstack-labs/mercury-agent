import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import type { SkillLoader } from '../skills/loader.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { BotManifest, BotPermissionsFile, BotPathScope } from './types.js';
import { BOT_DANGEROUS_TOOLS, BOT_SANDBOX_DIRNAME, BOT_SHARED_SANDBOX_DIRNAME } from './store.js';

/**
 * Tools a bot must never see, regardless of manifest. These are the tools
 * that prompt the user (bots run unattended), mutate the global permission
 * manifest, delegate to sub-agents, or manage schedules:
 */
const ALWAYS_STRIPPED = new Set([
  'ask_user',            // bots never ask questions mid-run
  'approve_scope',       // would persist scopes into the GLOBAL permissions.yaml
  'approve_command',     // same global-state mutation hazard
  'update_plan',         // plan UI has no bot surface
  'delegate_task',       // bots do not spawn sub-agents in P0
  'list_agents',
  'stop_agent',
  'install_skill',       // no skill installs from an unattended bot
  'schedule_task',       // bot schedules are managed via bot.yaml, not tools
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'send_message',        // channel messaging belongs to the owning surfaces
  'send_file',
  'bot_send',            // replaced by the bot-scoped instance after filtering
]);

export interface BotRegistryDeps {
  botId: string;
  manifest: BotManifest;
  botDir: string;
  /**
   * The bot's permissions.yaml — THE single source of truth for what this
   * bot may do: tool gate (tools), path scopes (paths), shell lists. The
   * persona is NOT a permission source (character only).
   */
  permissions: BotPermissionsFile;
  config: MercuryConfig;
  /** Per-bot memory store (P0-5); null until memory scoping is wired. */
  userMemory?: UserMemoryStore | null;
  /**
   * Skill access: when set, the bot gets list_skills + use_skill over the
   * global library AND its own skills dir (install_skill stays stripped).
   */
  skillLoader?: SkillLoader;
  /**
   * Sandbox areas granted implicitly (read/write/execute, no ask, no
   * persona declaration): deps.botDir/sandbox (private workspace) and the
   * fleet-shared folder next to the bots root. Unset = not granted.
   */
  sandbox?: { workspace: string; shared: string };
}

/**
 * Build a bot's own CapabilityRegistry + filtered toolset.
 *
 * Isolation model (BOTS-ARCHITECTURE.md §2.5):
 * - own PermissionManager instance — no shared mutable cwd/channel swapping
 * - NO ask handler: every approval path fails closed (auto-deny)
 * - channel type 'bot' — never 'internal' (internal auto-approves)
 * - shell auto-approve list emptied; safe-read classifier still applies
 * - no persistent-manifest writes: interactive mutation tools are stripped
 */
export function createBotCapabilityRegistry(deps: BotRegistryDeps): CapabilityRegistry {
  const registry = new CapabilityRegistry(deps.skillLoader);
  const pm = registry.permissions;

  // Reshape the manifest in place (never call save() — that writes the
  // global ~/.mercury/permissions.yaml, and bots have no path to it).
  const manifest = pm.getManifest();
  // Malformed scope entries (missing/empty `scope` — e.g. a hand-edited
  // permissions.yaml typo) must never crash every turn: skip + warn.
  const fileGrants = (deps.permissions.paths ?? []).filter(isValidScopeEntry);
  const skipped = (deps.permissions.paths?.length ?? 0) - fileGrants.length;
  if (skipped > 0) {
    logger.warn({ botId: deps.botId, skipped }, 'Malformed path-scope entries in permissions.yaml (missing "scope") skipped');
  }
  const granted = fileGrants;
  // Implicit sandbox grants come LAST and are never user-configurable away:
  // the private workspace and the fleet-shared folder are the bot's built-in
  // work areas (read/write/execute, no ask, no declaration).
  if (deps.sandbox) {
    mkdirSync(deps.sandbox.workspace, { recursive: true });
    mkdirSync(deps.sandbox.shared, { recursive: true });
    granted.push(
      { scope: deps.sandbox.workspace, read: true, write: true, execute: true },
      { scope: deps.sandbox.shared, read: true, write: true, execute: true },
    );
  }
  manifest.capabilities.filesystem.scopes = buildBotScopes(granted, deps.botDir);
  // Shell execution: instead of emptying autoApproved (which made every
  // non-safe-read command deny, breaking browser/file tooling), bots declare
  // their own allow-list via permissions.yaml autoApproveCommands. It is
  // carried in a dedicated PermissionManager field (NOT the manifest list)
  // so an ambient global autoApproved entry can never silently elevate an
  // unattended context. Fail-closed stays intact: no ask handler,
  // needsApproval wins, the global blocked list wins, and a literal "*"
  // grant is dropped (allow-all stays interactive-only).
  const approvedCommands = (deps.permissions.autoApproveCommands ?? [])
    .map(c => c.trim())
    .filter(c => c.length > 0 && c !== '*');
  manifest.capabilities.shell.autoApproved = [];
  pm.setBotShellAllowList(approvedCommands);
  manifest.capabilities.shell.blocked = [
    ...new Set([...manifest.capabilities.shell.blocked, ...(deps.permissions.blockedCommands ?? [])]),
  ];

  // Fail-closed core: no ask handler, no allow-all, non-internal context.
  // Granted scopes apply without prompting; everything else denies.
  pm.setAutoApproveAll(false);
  pm.setFailClosed(true);
  pm.setCurrentContext('bot', deps.botId);

  // Relative paths and shell commands resolve inside the bot's workspace,
  // never the daemon's cwd (a bot with a wide grant wrote "sandbox/…" files
  // into whatever repo the daemon happened to be started from).
  registry.setCwd(deps.sandbox?.workspace ?? process.cwd());
  registry.registerAll();

  const tools = filterBotTools(registry.getTools(), deps.manifest, deps.permissions);
  logger.info(
    { botId: deps.botId, tools: Object.keys(tools).length, scopes: manifest.capabilities.filesystem.scopes.length },
    'Bot capability registry built (fail-closed, isolated)',
  );
  return registry;
}

/**
 * Tool-set filter. The gate comes from the bot's permissions.yaml
 * (`tools.allow/deny`) — the single source of truth. Legacy fallback: a
 * manifest that still carries an explicit tools block (pre-migration
 * bot.yaml) is honored; with NEITHER source configured, the fail-closed
 * dangerous-tool deny list applies (same default as manifest
 * normalization). Interactive/global-mutation tools are always stripped;
 * deny wins over allow; a non-empty allow restricts the toolset to exactly
 * that list.
 */
export function filterBotTools(all: Record<string, any>, manifest: BotManifest, permissions?: BotPermissionsFile): Record<string, any> {
  const explicitManifestTools = (manifest as any).tools !== undefined;
  const gate = permissions?.tools
    ?? (explicitManifestTools ? manifest.tools : undefined)
    ?? { deny: [...BOT_DANGEROUS_TOOLS] };
  const allow = gate.allow ?? [];
  const deny = new Set(gate.deny ?? []);
  const out: Record<string, any> = {};
  for (const [name, tool] of Object.entries(all)) {
    if (ALWAYS_STRIPPED.has(name)) continue;
    if (deny.has(name)) continue;
    if (allow.length > 0 && !allow.includes(name)) continue;
    out[name] = tool;
  }
  return out;
}

/**
 * Bot path scopes from permissions.yaml + persona Access grants. 'self'
 * resolves to the bot's own profile dir; everything else resolves against
 * cwd or home (~). An unconfigured bot gets NO filesystem access
 * (fail-closed) — but the store always writes a default self scope at
 * creation.
 */
/** A scope entry is usable only with a non-empty string scope. */
function isValidScopeEntry(p: BotPathScope | undefined): boolean {
  return !!p && typeof p.scope === 'string' && p.scope.trim().length > 0;
}

/**
 * Union of path-scope grants keyed by resolved path: the same path granted
 * twice unions its modes. Used by the permission migration to fold legacy
 * persona Access grants into the permissions.yaml paths block.
 */
export function mergePathScopes(
  baseScopes: BotPathScope[] | undefined,
  extraScopes: BotPathScope[],
): BotPathScope[] {
  if (extraScopes.length === 0) return baseScopes ?? [];
  const merged = [...(baseScopes ?? [])];
  for (const grant of extraScopes) {
    const key = normalizeScopeKey(grant.scope);
    const existing = merged.find(p => normalizeScopeKey(p.scope) === key);
    if (existing) {
      existing.read = existing.read || grant.read;
      existing.write = existing.write || grant.write;
      existing.execute = existing.execute || grant.execute;
    } else {
      merged.push(grant);
    }
  }
  return merged;
}

/** Key for grant de-duplication: resolved absolute path ('self' resolved later). */
function normalizeScopeKey(scope: string): string {
  return scope === 'self' ? 'self' : resolve(scope.replace(/^~/, homedir())).toLowerCase();
}

function buildBotScopes(paths: BotPathScope[] | undefined, botDir: string): Array<{ path: string; read: boolean; write: boolean; execute?: boolean }> {
  const scopes: Array<{ path: string; read: boolean; write: boolean; execute?: boolean }> = [];
  for (const p of paths ?? []) {
    if (!isValidScopeEntry(p)) continue;
    const resolved = p.scope === 'self'
      ? resolve(botDir)
      : resolve(p.scope.replace(/^~/, homedir()));
    scopes.push({ path: resolved, read: p.read ?? false, write: p.write ?? false, execute: p.execute || undefined });
  }
  return scopes;
}