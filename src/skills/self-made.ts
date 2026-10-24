/**
 * Self-made skills (ADR-027): procedures Mercury writes for itself after a
 * long task worked, so the next time is one `use_skill` away. They live in
 * their own category folder (`<skills>/self-made/<slug>/SKILL.md`) and are
 * labelled as unverified until they have been used again, so an owner can
 * always tell a curated skill from one Mercury made on the go.
 *
 * Hygiene keeps the shelf honest: a self-made skill that is never used again
 * goes dormant (disabled, not deleted) after DORMANT_AFTER_DAYS, and the shelf
 * is capped at MAX_SELF_MADE live skills (least recently used go dormant).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from '../utils/logger.js';
import { looksLikeSecret } from '../learning/text.js';

export const SELF_MADE_CATEGORY = 'self-made';
export const SELF_MADE_LABEL = 'Self-made (Mercury wrote these on the go; unverified until used again)';
export const DORMANT_AFTER_DAYS = 30;
export const MAX_SELF_MADE = 40;
export const MIN_INSTRUCTION_CHARS = 200;
export const MAX_INSTRUCTION_CHARS = 12_000;
const SKILL_FILE = 'SKILL.md';
const DISABLED_FILE = '.disabled';
const DAY = 86_400_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,48}$/;

export interface SelfMadeDraft {
  name: string;
  description: string;
  intents: string[];
  instructions: string;
  /** What was checked when it worked (one line); the proof the skill is not a guess. */
  verified: string;
  allowedTools?: string[];
}

export interface SelfMadeMeta {
  name: string;
  description: string;
  category: typeof SELF_MADE_CATEGORY;
  origin: 'mercury';
  intents: string[];
  made: string;
  verified: string;
  uses: number;
  last_used?: string;
  'allowed-tools'?: string[];
}

export interface SelfMadeEntry {
  name: string;
  description: string;
  dir: string;
  made: number;
  uses: number;
  lastUsed: number | null;
  active: boolean;
}

/** Normalise a free-text name to a slug; returns null when nothing usable remains. */
export function slugify(name: string): string | null {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 49);
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Validate a draft the model produced. Returns the reason it is not worth
 * keeping, or null. Deliberately strict: a half-written skill is junk the owner
 * has to clean up later.
 */
export function rejectDraft(draft: SelfMadeDraft): string | null {
  if (!slugify(draft.name)) return 'name must be 3–49 characters of letters, digits and dashes';
  const description = draft.description?.trim() ?? '';
  if (description.length < 20 || description.length > 220) return 'description must be 20–220 characters: what it does and for which inputs';
  const intents = (draft.intents ?? []).map((i) => i.trim()).filter(Boolean);
  if (intents.length === 0) return 'at least one intent phrase (how the owner would ask for this)';
  const instructions = draft.instructions?.trim() ?? '';
  if (instructions.length < MIN_INSTRUCTION_CHARS) return `instructions are too short (${instructions.length} chars; a real procedure needs at least ${MIN_INSTRUCTION_CHARS})`;
  if (instructions.length > MAX_INSTRUCTION_CHARS) return `instructions are too long (${instructions.length} chars; keep the procedure under ${MAX_INSTRUCTION_CHARS})`;
  if (!/(^|\n)\s*(1[.)]|- |\* |## )/.test(instructions)) return 'instructions must be a procedure: numbered steps or bullet points';
  if (!draft.verified || draft.verified.trim().length < 12) return 'say what you verified when it worked (one line); unverified procedures are not saved';
  if (looksLikeSecret(instructions) || looksLikeSecret(description) || looksLikeSecret(draft.verified)) return 'instructions contain something that looks like a credential; refer to where it is configured instead';
  return null;
}

/** The SKILL.md text for a draft, keeping `made` and `uses` from an earlier version. */
export function composeSkillMd(draft: SelfMadeDraft, prior?: Pick<SelfMadeMeta, 'made' | 'uses' | 'last_used'>, now = Date.now()): string {
  const slug = slugify(draft.name)!;
  const meta: SelfMadeMeta = {
    name: slug,
    description: draft.description.trim(),
    category: SELF_MADE_CATEGORY,
    origin: 'mercury',
    intents: draft.intents.map((i) => i.trim()).filter(Boolean).slice(0, 12),
    made: prior?.made ?? new Date(now).toISOString(),
    verified: draft.verified.trim(),
    uses: prior?.uses ?? 0,
    ...(prior?.last_used ? { last_used: prior.last_used } : {}),
    ...(draft.allowedTools && draft.allowedTools.length > 0 ? { 'allowed-tools': draft.allowedTools } : {}),
  };
  const body = draft.instructions.trim();
  const title = body.startsWith('#') ? '' : `# ${slug}\n\n`;
  return `---\n${stringifyYaml(meta).trim()}\n---\n\n${title}${body}\n`;
}

export function readSelfMadeMeta(skillMd: string): SelfMadeMeta | null {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(skillMd);
  if (!m) return null;
  try {
    const meta = parseYaml(m[1]) as Partial<SelfMadeMeta>;
    if (meta?.category !== SELF_MADE_CATEGORY || !meta.name) return null;
    return { uses: 0, intents: [], made: '', verified: '', description: '', origin: 'mercury', ...meta } as SelfMadeMeta;
  } catch {
    return null;
  }
}

/** The self-made folder inside a skills root. */
export function selfMadeRoot(skillsDir: string): string {
  return join(skillsDir, SELF_MADE_CATEGORY);
}

export function listSelfMade(skillsDir: string): SelfMadeEntry[] {
  const root = selfMadeRoot(skillsDir);
  if (!existsSync(root)) return [];
  const out: SelfMadeEntry[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const dir = join(root, entry.name);
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) continue;
    try {
      const meta = readSelfMadeMeta(readFileSync(file, 'utf-8'));
      if (!meta) continue;
      out.push({
        name: meta.name,
        description: meta.description,
        dir,
        made: Date.parse(meta.made) || 0,
        uses: Number(meta.uses) || 0,
        lastUsed: meta.last_used ? Date.parse(meta.last_used) || null : null,
        active: !existsSync(join(dir, DISABLED_FILE)),
      });
    } catch (err) {
      logger.debug({ err, dir }, 'unreadable self-made skill');
    }
  }
  return out.sort((a, b) => (b.lastUsed ?? b.made) - (a.lastUsed ?? a.made));
}

/** Bump `uses` / `last_used` in the frontmatter when a self-made skill is invoked. */
export function recordSelfMadeUse(skillsDir: string, name: string, now = Date.now()): boolean {
  const file = join(selfMadeRoot(skillsDir), name, SKILL_FILE);
  if (!existsSync(file)) return false;
  try {
    const raw = readFileSync(file, 'utf-8');
    const m = /^---\s*\n([\s\S]*?)\n---([\s\S]*)$/.exec(raw);
    if (!m) return false;
    const meta = parseYaml(m[1]) as Record<string, unknown>;
    if (meta.category !== SELF_MADE_CATEGORY) return false;
    meta.uses = (Number(meta.uses) || 0) + 1;
    meta.last_used = new Date(now).toISOString();
    writeFileSync(file, `---\n${stringifyYaml(meta).trim()}\n---${m[2]}`, 'utf-8');
    return true;
  } catch (err) {
    logger.debug({ err, name }, 'could not record self-made skill use');
    return false;
  }
}

/**
 * Dormancy pass: never-used skills older than DORMANT_AFTER_DAYS and anything
 * beyond MAX_SELF_MADE (least recently used first) get a `.disabled` marker.
 * Nothing is deleted; `/skills self-made` shows dormant ones and the owner can
 * re-enable or remove them.
 */
export function selfMadeHygiene(skillsDir: string, now = Date.now()): { dormant: string[] } {
  const live = listSelfMade(skillsDir).filter((s) => s.active);
  const dormant: string[] = [];
  const disable = (s: SelfMadeEntry, why: string) => {
    try {
      writeFileSync(join(s.dir, DISABLED_FILE), `dormant: ${why}\n`, 'utf-8');
      dormant.push(s.name);
      logger.info({ skill: s.name, why }, 'Self-made skill went dormant');
    } catch (err) {
      logger.debug({ err, skill: s.name }, 'could not mark self-made skill dormant');
    }
  };
  const remaining: SelfMadeEntry[] = [];
  for (const s of live) {
    if (s.uses === 0 && s.made > 0 && now - s.made >= DORMANT_AFTER_DAYS * DAY) disable(s, `never used in ${DORMANT_AFTER_DAYS} days`);
    else remaining.push(s);
  }
  if (remaining.length > MAX_SELF_MADE) {
    const byRecency = [...remaining].sort((a, b) => (a.lastUsed ?? a.made) - (b.lastUsed ?? b.made));
    for (const s of byRecency.slice(0, remaining.length - MAX_SELF_MADE)) disable(s, `shelf over ${MAX_SELF_MADE}`);
  }
  return { dormant };
}
