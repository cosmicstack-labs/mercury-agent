import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type {
  BotManifest,
  BotPermissionsFile,
} from './types.js';

export const BOT_MANIFEST_FILENAME = 'bot.yaml';
export const BOT_PERSONA_FILENAME = 'persona.md';
export const BOT_PERMISSIONS_FILENAME = 'permissions.yaml';
export const BOT_ENV_FILENAME = '.env';
export const BOT_JOURNAL_FILENAME = 'journal.jsonl';

/** Lowercase alphanumeric ids — same discipline as skill ids (traversal guard). */
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Tools that are deny-by-default for every bot unless explicitly allowed. */
export const BOT_DANGEROUS_TOOLS = [
  'run_command',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'git_commit',
  'git_push',
] as const;

export function assertValidBotId(id: string): void {
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid bot id "${id}": must match ${BOT_ID_PATTERN.source} (lowercase letters, digits, dashes; max 48 chars)`);
  }
}

/**
 * Structural validation of a bot manifest. Returns error strings; an empty
 * array means the manifest is usable. Never throws on user input.
 */
export function validateBotManifest(manifest: Partial<BotManifest>): string[] {
  const errors: string[] = [];
  try {
    assertValidBotId(manifest.id ?? '');
  } catch (err: any) {
    errors.push(err.message);
  }
  if (!manifest.name || typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    errors.push('name is required');
  }
  const schedules = manifest.schedules ?? [];
  for (const s of schedules) {
    if (!s.name || !s.prompt) errors.push(`schedule ${s.name || '(unnamed)'}: name and prompt are required`);
    if (!isValidCronExpression(s.cron ?? '')) {
      errors.push(`schedule ${s.name || '(unnamed)'}: "${s.cron}" is not a 5-field cron expression`);
    }
  }
  const crossRecall = manifest.memory?.allowCrossBotRecall ?? [];
  for (const other of crossRecall) {
    if (other === manifest.id) errors.push('allowCrossBotRecall cannot include the bot itself');
  }
  const canMessage = manifest.comms?.canMessage ?? [];
  for (const other of canMessage) {
    if (other === manifest.id) errors.push('canMessage cannot include the bot itself');
  }
  return errors;
}

export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every(f => f.length > 0);
}

export interface CreateBotInput {
  id: string;
  name: string;
  description?: string;
  /** Persona markdown; omit to write the template. */
  persona?: string;
  manifest?: Partial<Omit<BotManifest, 'id' | 'name' | 'createdAt' | 'updatedAt'>>;
}

const DEFAULT_PERSONA_TEMPLATE = (name: string, description?: string) =>
`# ${name}

${description || 'A Mercury bot — a focused specialist.'}

## Character

You are ${name}. Stay in character at all times. You are a specialist:
stay inside your domain of expertise, and say so plainly when a request
falls outside it.

## Standing instructions

- Be concise and concrete; prefer decisions over deliberation.
- You never ask the user questions mid-run: if a required input is missing,
  state the assumption you are proceeding with.
- If you lack permission for an action, stop and report it in your summary
  instead of attempting a workaround.

## Output

- Lead with the outcome, then the details.
- Include the evidence (links, file paths, numbers) behind each claim.
`;

function atomicWrite(filePath: string, content: string, mode: number = 0o600): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode });
  renameSync(tmp, filePath);
}

/**
 * Filesystem store for bot profiles: `~/.mercury/bots/<id>/`.
 * Mirrors SkillStore's dependency-injected-root testability and traversal
 * guards, and SessionRepository's atomic tmp+rename writes.
 */
export class BotStore {
  readonly botsRoot: string;

  constructor(botsRoot?: string) {
    this.botsRoot = resolve(botsRoot ?? join(getMercuryHome(), 'bots'));
  }

  /** Bot directory for an id, with traversal guard. Throws on invalid ids. */
  botDir(id: string): string {
    assertValidBotId(id);
    const dir = resolve(this.botsRoot, id);
    const root = resolve(this.botsRoot);
    if (!dir.startsWith(root + sep)) {
      throw new Error(`Invalid bot id "${id}": escapes the bots root`);
    }
    return dir;
  }

  list(): BotManifest[] {
    if (!existsSync(this.botsRoot)) return [];
    const manifests: BotManifest[] = [];
    for (const entry of readdirSync(this.botsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      try {
        const m = this.get(entry.name);
        if (m) manifests.push(m);
      } catch (err: any) {
        logger.warn({ botId: entry.name, err: err?.message }, 'Skipping unreadable bot profile');
      }
    }
    return manifests.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): BotManifest | null {
    const file = join(this.botDir(id), BOT_MANIFEST_FILENAME);
    if (!existsSync(file)) return null;
    const raw = parseYaml(readFileSync(file, 'utf-8')) as Partial<BotManifest>;
    if (!raw || raw.id !== id) {
      throw new Error(`Bot manifest for "${id}" is missing or has a mismatched id`);
    }
    return normalizeBotManifest(raw);
  }

  exists(id: string): boolean {
    try {
      return existsSync(join(this.botDir(id), BOT_MANIFEST_FILENAME));
    } catch {
      return false;
    }
  }

  create(input: CreateBotInput): BotManifest {
    const id = input.id.toLowerCase();
    if (this.exists(id)) {
      throw new Error(`Bot "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const manifest = normalizeBotManifest({
      ...input.manifest,
      id,
      name: input.name,
      description: input.description,
      enabled: input.manifest?.enabled ?? true,
      persona: input.manifest?.persona ?? BOT_PERSONA_FILENAME,
      createdAt: now,
      updatedAt: now,
    } as Partial<BotManifest>);
    const errors = validateBotManifest(manifest);
    if (errors.length > 0) {
      throw new Error(`Invalid bot manifest: ${errors.join('; ')}`);
    }

    const dir = this.botDir(id);
    mkdirSync(dir, { recursive: true });
    this.save(manifest);
    const personaFile = join(dir, manifest.persona ?? BOT_PERSONA_FILENAME);
    if (!existsSync(personaFile)) {
      writeFileSync(personaFile, input.persona ?? DEFAULT_PERSONA_TEMPLATE(input.name, input.description), 'utf-8');
    }
    const permFile = join(dir, BOT_PERMISSIONS_FILENAME);
    if (!existsSync(permFile)) {
      // Fail-closed default: only the bot's own dir, read+write.
      this.writePermissions(id, {
        paths: [{ scope: 'self', read: true, write: true }],
      });
    }
    return manifest;
  }

  save(manifest: BotManifest): void {
    assertValidBotId(manifest.id);
    const dir = this.botDir(manifest.id);
    if (!existsSync(dir)) {
      throw new Error(`Bot "${manifest.id}" does not exist`);
    }
    const errors = validateBotManifest(manifest);
    if (errors.length > 0) {
      throw new Error(`Invalid bot manifest: ${errors.join('; ')}`);
    }
    manifest.updatedAt = new Date().toISOString();
    atomicWrite(join(dir, BOT_MANIFEST_FILENAME), stringifyYaml(manifest));
  }

  update(id: string, mutator: (m: BotManifest) => void): BotManifest {
    const manifest = this.get(id);
    if (!manifest) throw new Error(`Bot "${id}" does not exist`);
    mutator(manifest);
    manifest.updatedAt = new Date().toISOString();
    this.save(manifest);
    return manifest;
  }

  setEnabled(id: string, enabled: boolean): BotManifest {
    return this.update(id, m => { m.enabled = enabled; });
  }

  delete(id: string): void {
    const dir = this.botDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      logger.info({ botId: id }, 'Bot profile deleted');
    }
  }

  readPersona(id: string): string {
    const manifest = this.get(id);
    const personaName = manifest?.persona ?? BOT_PERSONA_FILENAME;
    const file = join(this.botDir(id), personaName);
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  }

  writePersona(id: string, content: string): void {
    const manifest = this.get(id);
    const personaName = manifest?.persona ?? BOT_PERSONA_FILENAME;
    atomicWrite(join(this.botDir(id), personaName), content, 0o644);
  }

  readPermissions(id: string): BotPermissionsFile {
    const file = join(this.botDir(id), BOT_PERMISSIONS_FILENAME);
    if (!existsSync(file)) return {};
    return (parseYaml(readFileSync(file, 'utf-8')) ?? {}) as BotPermissionsFile;
  }

  writePermissions(id: string, permissions: BotPermissionsFile): void {
    atomicWrite(join(this.botDir(id), BOT_PERMISSIONS_FILENAME), stringifyYaml(permissions));
  }

  /** Directory sizes for the /bots storage view. */
  usage(): Array<{ id: string; bytes: number; journalBytes: number }> {
    if (!existsSync(this.botsRoot)) return [];
    const out: Array<{ id: string; bytes: number; journalBytes: number }> = [];
    for (const m of this.list()) {
      const dir = this.botDir(m.id);
      out.push({ id: m.id, bytes: treeSize(dir), journalBytes: journalTreeSize(dir) });
    }
    return out;
  }
}

function treeSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += treeSize(p);
      else total += statSync(p).size;
    }
  } catch { /* unreadable entries count as 0 */ }
  return total;
}

function journalTreeSize(dir: string): number {
  return readdirSync(dir)
    .filter(f => f === 'journal.jsonl' || /^journal\.jsonl\.\d+$/.test(f))
    .reduce((acc, f) => {
      try { return acc + statSync(join(dir, f)).size; } catch { return acc; }
    }, 0);
}

function normalizeBotManifest(raw: Partial<BotManifest>): BotManifest {
  // Normalize deny list: dangerous tools are denied unless explicitly allowed
  // via tools.allow. Deny always wins over allow.
  const allow = raw.tools?.allow ?? [];
  const explicitDeny = raw.tools?.deny ?? [];
  const deny = new Set<string>(explicitDeny);
  if (allow.length === 0) {
    for (const t of BOT_DANGEROUS_TOOLS) deny.add(t);
  }
  return {
    ...raw,
    enabled: raw.enabled ?? false,
    persona: raw.persona ?? BOT_PERSONA_FILENAME,
    memory: { scope: raw.memory?.scope ?? 'own', allowCrossBotRecall: raw.memory?.allowCrossBotRecall },
    tools: { allow, deny: [...deny] },
  } as BotManifest;
}