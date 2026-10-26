/**
 * The owner's permission mode, chosen once and remembered.
 *
 * Since 1.3.1 `mercury` attaches to the background runtime, which never ran
 * the "Allow All / Ask Me" prompt: every new user landed in Ask Me without
 * being asked, and a choice made in a foreground terminal was lost on
 * restart. The choice now lives in ~/.mercury/permission-mode.json and is
 * applied by every surface the owner uses (terminal, attached terminal,
 * dashboard). `null` means it was never chosen, so the next surface asks.
 *
 * It applies to the owner's own surfaces only. Telegram, WhatsApp and other
 * chats keep their own per-chat handling, so a saved Allow All never
 * reaches a member or a group.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

export type SavedPermissionMode = 'ask-me' | 'allow-all';

function file(): string {
  return join(getMercuryHome(), 'permission-mode.json');
}

export function loadPermissionMode(): SavedPermissionMode | null {
  try {
    if (!existsSync(file())) return null;
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { mode?: unknown };
    return raw.mode === 'allow-all' || raw.mode === 'ask-me' ? raw.mode : null;
  } catch {
    return null;
  }
}

export function savePermissionMode(mode: SavedPermissionMode): void {
  writeFileSync(file(), JSON.stringify({ mode, chosenAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

/** One line for the bar and for confirmations. */
export function describePermissionMode(mode: SavedPermissionMode): string {
  return mode === 'allow-all'
    ? 'Allow All: Mercury acts without asking (blocked commands stay blocked).'
    : 'Ask Me: Mercury asks before risky actions such as writing files or running commands.';
}
