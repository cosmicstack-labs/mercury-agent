import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { BotManifest, BotPermissionsFile, BotPathScope } from './types.js';

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
  permissions: BotPermissionsFile;
  config: MercuryConfig;
  /** Per-bot memory store (P0-5); null until memory scoping is wired. */
  userMemory?: UserMemoryStore | null;
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
  const registry = new CapabilityRegistry();
  const pm = registry.permissions;

  // Reshape the manifest in place (never call save() — that writes the
  // global ~/.mercury/permissions.yaml, and bots have no path to it).
  const manifest = pm.getManifest();
  manifest.capabilities.filesystem.scopes = buildBotScopes(deps.permissions.paths, deps.botDir);
  manifest.capabilities.shell.autoApproved = [];
  manifest.capabilities.shell.blocked = [
    ...new Set([...manifest.capabilities.shell.blocked, ...(deps.permissions.blockedCommands ?? [])]),
  ];

  // Fail-closed core: no ask handler, no allow-all, non-internal context.
  // Granted scopes apply without prompting; everything else denies.
  pm.setAutoApproveAll(false);
  pm.setFailClosed(true);
  pm.setCurrentContext('bot', deps.botId);

  registry.setCwd(process.cwd());
  registry.registerAll();

  const tools = filterBotTools(registry.getTools(), deps.manifest);
  logger.info(
    { botId: deps.botId, tools: Object.keys(tools).length, scopes: manifest.capabilities.filesystem.scopes.length },
    'Bot capability registry built (fail-closed, isolated)',
  );
  return registry;
}

/**
 * Tool-set filter: interactive/global-mutation tools always stripped, then
 * the manifest's allow/deny applied (deny wins; a non-empty allow restricts
 * the toolset to exactly that list).
 */
export function filterBotTools(all: Record<string, any>, manifest: BotManifest): Record<string, any> {
  const allow = manifest.tools?.allow ?? [];
  const deny = new Set(manifest.tools?.deny ?? []);
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
 * Bot path scopes from permissions.yaml. 'self' resolves to the bot's own
 * profile dir; everything else resolves against cwd or home (~). An
 * unconfigured bot gets NO filesystem access (fail-closed) — but the store
 * always writes a default self scope at creation.
 */
function buildBotScopes(paths: BotPathScope[] | undefined, botDir: string): Array<{ path: string; read: boolean; write: boolean }> {
  const scopes: Array<{ path: string; read: boolean; write: boolean }> = [];
  for (const p of paths ?? []) {
    const resolved = p.scope === 'self'
      ? resolve(botDir)
      : resolve(p.scope.replace(/^~/, homedir()));
    scopes.push({ path: resolved, read: p.read ?? false, write: p.write ?? false });
  }
  return scopes;
}