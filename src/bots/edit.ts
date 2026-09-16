import type { BotManifest } from './types.js';

/**
 * Editable dot-paths on a bot manifest (`/bots edit <id> <path> <value>`).
 * Deliberately excludes `id` (identity) and `enabled` (has its own
 * enable/disable commands with halt semantics).
 */
export const EDITABLE_PATHS = [
  'name',
  'description',
  'model.provider',
  'model.model',
  'memory.scope',              // none | own | shared-read
  'memory.allowCrossBotRecall',// comma-separated bot ids
  'comms.canMessage',          // comma-separated bot ids
  'tools.allow',               // comma-separated tool names
  'tools.deny',                // comma-separated tool names
  'autonomy.maxConcurrent',
  'autonomy.maxSteps',
  'autonomy.dailyTokenBudget', // number or "none" (unlimited, default)
] as const;

export type EditResult = { ok: true; value: unknown; display: string } | { ok: false; error: string };

/**
 * Parse and apply a dot-path field edit onto a manifest (in place).
 * Value parsing: integer → number, "true"/"false" → boolean, comma list →
 * string[], "none" on dailyTokenBudget → undefined (unlimited).
 */
export function applyBotFieldPatch(manifest: BotManifest, path: string, rawValue: string): EditResult {
  const value = rawValue.trim();
  if (!(EDITABLE_PATHS as readonly string[]).includes(path)) {
    return { ok: false, error: `Unknown field "${path}". Editable: ${EDITABLE_PATHS.join(', ')}` };
  }

  const segments = path.split('.');
  const last = segments[segments.length - 1];
  let parsed: unknown = value;

  if (last === 'dailyTokenBudget') {
    if (value.toLowerCase() === 'none' || value === '') {
      parsed = undefined; // budget disabled (the default)
    } else {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'dailyTokenBudget must be a positive integer or "none"' };
      parsed = n;
    }
  } else if (last === 'maxSteps' || last === 'maxConcurrent') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: `${last} must be a positive integer` };
    parsed = n;
  } else if (last === 'scope') {
    if (!['none', 'own', 'shared-read'].includes(value)) {
      return { ok: false, error: 'memory.scope must be one of: none, own, shared-read' };
    }
  } else if (['allowCrossBotRecall', 'canMessage', 'allow', 'deny'].includes(last)) {
    parsed = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } else if (last === 'name') {
    if (!value) return { ok: false, error: 'name cannot be empty' };
  }

  // Walk/set the nested path.
  let target: any = manifest;
  for (const seg of segments.slice(0, -1)) {
    if (target[seg] === undefined || target[seg] === null) target[seg] = {};
    target = target[seg];
  }
  // Removing a value (dailyTokenBudget=none): delete the key entirely.
  if (parsed === undefined) {
    delete target[last];
  } else {
    target[last] = parsed;
  }
  return {
    ok: true,
    value: parsed,
    display: parsed === undefined
      ? 'none (unlimited)'
      : Array.isArray(parsed) ? parsed.join(', ')
      : typeof parsed === 'number' ? parsed.toLocaleString('en-US')
      : String(parsed),
  };
}