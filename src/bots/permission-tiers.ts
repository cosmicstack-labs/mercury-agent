import { BOT_DANGEROUS_TOOLS } from './store.js';
import type { BotPermissionsFile } from './types.js';

/**
 * Onboarding permission tiers — one clear question instead of silent
 * fail-closed defaults + manual file editing. A tier is THE user's choice at
 * onboarding, so it must EXECUTE: it writes the full permissions.yaml
 * (single source of truth) — both the tool gate AND the path scopes. The old
 * manifest-only behavior left the path gate untouched, so a "Full access"
 * bot still could not read anything outside its sandbox — chosen
 * permissions that never took effect.
 *
 * Path grants per tier (fail-closed outside these):
 *  - readonly: own profile dir, read-only
 *  - builder:  own profile dir, read+write
 *  - operator: own profile dir, read+write+execute
 *  - full:     the whole home directory, read+write+execute — an explicit,
 *              informed choice for trusted automation (the global blocked
 *              list still applies; interactive tools stay stripped).
 */
export type PermissionTier = 'readonly' | 'builder' | 'operator' | 'full';

export const PERMISSION_TIERS: Record<PermissionTier, { label: string; description: string; deny: string[] }> = {
  readonly: {
    label: 'Read-only (recommended default)',
    description: 'Browse, search, read files, message bots. No execution, no file writes.',
    deny: [...BOT_DANGEROUS_TOOLS],
  },
  builder: {
    label: 'Builder — can write files',
    description: 'Read-only + create/edit/write files inside its granted scopes. Still no shell.',
    deny: ['run_command', 'delete_file', 'git_commit', 'git_push'],
  },
  operator: {
    label: 'Operator — can run commands',
    description: 'Builder + run_command. Execution still restricted to its granted path scopes (fail-closed), global blocked list applies.',
    deny: ['delete_file', 'git_commit', 'git_push'],
  },
  full: {
    label: 'Full access',
    description: 'Everything, including file deletion and your home directory. For trusted automation only.',
    deny: [],
  },
};

export function isPermissionTier(value: string): value is PermissionTier {
  return value in PERMISSION_TIERS;
}

/**
 * The permissions.yaml a tier grants — tool gate + path scopes, one file.
 * `self` resolves to the bot's own profile dir at registry build time, so
 * tier files are identical across bots and safe to copy (fleet inheritance).
 */
export function tierPermissionsFile(tier: PermissionTier): BotPermissionsFile {
  const file: BotPermissionsFile = {
    paths: [{ scope: 'self', read: true, write: true, execute: tier === 'operator' || tier === 'full' }],
    tools: { deny: [...PERMISSION_TIERS[tier].deny] },
  };
  if (tier === 'full') {
    file.paths!.push({ scope: '~', read: true, write: true, execute: true });
  }
  return file;
}

/**
 * Apply a tier to a manifest (in place) — LEGACY path kept for manifests
 * still carrying the old bot.yaml tools block; new code writes the tier via
 * tierPermissionsFile() into permissions.yaml instead.
 */
export function applyPermissionTier(manifest: { tools?: { allow?: string[]; deny?: string[] } }, tier: PermissionTier): void {
  manifest.tools = { ...(manifest.tools ?? {}), deny: [...PERMISSION_TIERS[tier].deny] };
}

/**
 * Which tier a permissions.yaml matches, or 'custom' when it was edited by
 * hand (extra paths, an allow list, a different deny list). The app shows the
 * tier by name, and 'custom' as exactly that.
 */
export function detectTier(perms: BotPermissionsFile | null | undefined): PermissionTier | 'custom' {
  if (!perms) return 'custom';
  const key = (f: BotPermissionsFile) => JSON.stringify({
    deny: [...(f.tools?.deny ?? [])].sort(),
    allow: [...(f.tools?.allow ?? [])].sort(),
    paths: (f.paths ?? []).map((p) => `${p.scope}:${p.read ? 'r' : ''}${p.write ? 'w' : ''}${p.execute ? 'x' : ''}`).sort(),
  });
  const mine = key(perms);
  for (const tier of Object.keys(PERMISSION_TIERS) as PermissionTier[]) {
    if (key(tierPermissionsFile(tier)) === mine) return tier;
  }
  return 'custom';
}
