import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import type { SkillDiscovery, Skill, SkillMeta } from './types.js';
import { recordSelfMadeUse, SELF_MADE_CATEGORY, SELF_MADE_LABEL } from './self-made.js';
import { IntentRouter } from './intent-router.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_SKILL_SEEDS, PREVIOUS_SEED_CONTENTS, RETIRED_SEEDS, getCategoryLabel } from './default-skills.js';

/**
 * The web-search skill dir holds a skill that tells the model to fetch a
 * search engine's HTML results page and never mentions the web_search tool.
 * Those pages answer automated requests with a bot challenge, so such a
 * skill only ever returns nothing.
 */
export function isBrokenSearchSkill(dirName: string, content: string): boolean {
  if (dirName !== 'web-search') return false;
  if (/\bweb_search\b/.test(content)) return false;
  return /(html|lite)\.duckduckgo\.com|duckduckgo\.com\/html|google\.[a-z.]+\/search\?|bing\.com\/search\?q=/i.test(content);
}

const SKILL_FILE = 'SKILL.md';
/** Which built-in skills were installed once (see ensureDefaultSkills). */
const SEEDED_FILE = '.seeded-defaults.json';
const DISABLED_FILE = '.disabled';

/**
 * Skill folders other agents share: `~/.agents/skills` (the cross-agent
 * standard that `npx skills add` installs into) and `~/.claude/skills`.
 * Skills there (HyperFrames, for one) are usable by name in Mercury too,
 * read-only. Mercury's own skills win on a name clash. Off with
 * MERCURY_SHARED_SKILLS=0.
 */
export function sharedSkillDirs(home = homedir()): string[] {
  if (process.env.MERCURY_SHARED_SKILLS === '0') return [];
  return [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')];
}

/** A shared skill's description for the always-sent list: its first sentence, short. */
function briefDescription(d: string, max = 160): string {
  const t = d.replace(/\s+/g, ' ').trim();
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return first.length <= max ? first : `${first.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

function parseSkillMd(content: string): { meta: SkillMeta; instructions: string } | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return null;

  try {
    const meta = parseYaml(fmMatch[1]) as SkillMeta;
    const instructions = fmMatch[2].trim();
    if (!meta.name || !meta.description) {
      logger.warn({ meta }, 'SKILL.md missing required fields (name, description)');
      return null;
    }
    return { meta, instructions };
  } catch (err) {
    logger.warn({ err }, 'Failed to parse SKILL.md frontmatter');
    return null;
  }
}

export class SkillLoader {
  private skillsDir: string;
  /** Additional read-only skill roots (e.g. a bot's own skills dir). Own-dir entries load after the primary dir, so they win on name collision. */
  private extraDirs: string[];
  /** Folders other agents share (sharedSkillDirs): read before the primary dir, so Mercury's own skills win. */
  private sharedDirs: string[];
  private sharedPaths = new Set<string>();
  private seedDefaults: boolean;
  private discovered: Map<string, SkillDiscovery> = new Map();
  private loaded: Map<string, Skill> = new Map();
  readonly intentRouter: IntentRouter;

  constructor(skillsDir?: string, options?: { extraDirs?: string[]; seedDefaults?: boolean; sharedDirs?: string[] }) {
    this.skillsDir = skillsDir || join(getMercuryHome(), 'skills');
    this.extraDirs = options?.extraDirs ?? [];
    // Only the owner's own loader reads shared folders (not bots, not a custom root).
    this.sharedDirs = options?.sharedDirs ?? (skillsDir ? [] : sharedSkillDirs());
    this.seedDefaults = options?.seedDefaults !== false;
    this.intentRouter = new IntentRouter();
  }

  discover(): SkillDiscovery[] {
    this.discovered.clear();
    this.loaded.clear();
    if (!existsSync(this.skillsDir)) {
      if (!this.seedDefaults) return [];
      mkdirSync(this.skillsDir, { recursive: true });
      this.seedTemplate();
    }

    if (this.seedDefaults) {
      this.retireOldDefaults();
      this.ensureDefaultSkills();
    }

    // Walk both layouts:
    //   - flat:   <skillsDir>/<name>/SKILL.md            (legacy + user-authored)
    //   - nested: <skillsDir>/<category>/<slug>/SKILL.md (mercury skills install)
    // User-installed nested skills win over flat ones on name collision (registered last).
    const skillPaths = this.findSkillFiles();
    const parsedSkills: Array<{ meta: SkillMeta; path: string }> = [];
    for (const skillPath of skillPaths) {
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed) continue;
        this.discovered.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
          ...(this.sharedPaths.has(skillPath) ? { shared: true } : {}),
        });
        parsedSkills.push({ meta: parsed.meta, path: skillPath });
      } catch (err) {
        logger.warn({ path: skillPath, err }, 'Failed to load skill');
      }
    }

    // Reset the router with the bare list first, then enrich every entry with
    // its category, intents and tags. (The other order wiped the metadata on
    // every scan, so grouping and intent routing silently fell back to names.)
    this.intentRouter.buildIndex([...this.discovered.values()]);
    for (const { meta, path } of parsedSkills) {
      this.intentRouter.registerSkillMeta(meta);
      logger.info({ skill: meta.name, path, category: meta.category, intents: meta.intents?.length }, 'Skill discovered');
    }

    return [...this.discovered.values()];
  }

  load(name: string): Skill | null {
    const cached = this.loaded.get(name);
    if (cached) return cached;

    const skillPaths = this.findSkillFiles();
    let lastMatch: Skill | null = null;
    for (const skillPath of skillPaths) {
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed || parsed.meta.name !== name) continue;

        const skillDir = join(skillPath, '..');
        const skill: Skill = {
          ...parsed.meta,
          instructions: parsed.instructions,
          dir: skillDir,
          ...(this.sharedPaths.has(skillPath) ? { shared: true } : {}),
          scriptsDir: existsSync(join(skillDir, 'scripts')) ? join(skillDir, 'scripts') : undefined,
          referencesDir: existsSync(join(skillDir, 'references')) ? join(skillDir, 'references') : undefined,
        };
        // Nested wins over flat — keep walking and prefer the deepest match.
        lastMatch = skill;
      } catch (err) {
        logger.warn({ err, name }, 'Failed to load skill');
      }
    }
    if (lastMatch) {
      this.loaded.set(name, lastMatch);
      return lastMatch;
    }
    return null;
  }

  /**
   * Walk the skills directory and return absolute paths to every SKILL.md found,
   * supporting both flat (<dir>/SKILL.md) and nested (<category>/<slug>/SKILL.md)
   * layouts. Skips directories starting with "_" and any tree containing a
   * `.disabled` marker.
   */
  private findSkillFiles(): string[] {
    const out: string[] = [];
    // Shared first: later entries win on a name clash, so Mercury's own skills override.
    for (const dir of this.sharedDirs) {
      const before = out.length;
      this.findSkillFilesIn(dir, out);
      for (const p of out.slice(before)) this.sharedPaths.add(p);
    }
    // The same skill in two shared folders (~/.agents and ~/.claude): keep one.
    const seen = new Set<string>();
    for (let i = out.length - 1; i >= 0; i--) {
      const name = out[i].split(sep).slice(-2, -1)[0];
      if (seen.has(name)) out.splice(i, 1); else seen.add(name);
    }
    for (const dir of [this.skillsDir, ...this.extraDirs]) {
      this.findSkillFilesIn(dir, out);
    }
    return out;
  }

  /** The discovered skill closest to a name the user or model wrote ("hyperframe", "Hyper Frames"). */
  closest(name: string): string | null {
    const sq = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, '').replace(/s$/, '');
    const n = sq(name);
    if (n.length < 3) return null;
    const names = [...this.discovered.keys()];
    return names.find((k) => sq(k) === n)
      ?? names.filter((k) => sq(k).startsWith(n) || n.startsWith(sq(k))).sort((a, b) => a.length - b.length)[0]
      ?? null;
  }

  /** Walk one skills root (flat + one nested category level), appending SKILL.md paths. */
  private findSkillFilesIn(skillsDir: string, out: string[]): string[] {
    if (!existsSync(skillsDir)) return out;

    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const dir = join(skillsDir, entry.name);
      if (existsSync(join(dir, DISABLED_FILE))) continue;

      const flat = join(dir, SKILL_FILE);
      if (existsSync(flat)) {
        out.push(flat);
        continue;
      }
      // Treat as category folder: look one level deeper for <slug>/SKILL.md.
      let children: import('node:fs').Dirent[] = [];
      try {
        children = readdirSync(dir, { withFileTypes: true });
      } catch { continue; }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('_') || child.name.startsWith('.')) continue;
        const childDir = join(dir, child.name);
        if (existsSync(join(childDir, DISABLED_FILE))) continue;
        const nested = join(childDir, SKILL_FILE);
        if (existsSync(nested)) out.push(nested);
      }
    }
    return out;
  }

  getDiscovered(): SkillDiscovery[] {
    return [...this.discovered.values()];
  }

  /** The primary skills root (where self-made skills are written). */
  rootDir(): string {
    return this.skillsDir;
  }

  /** Count a use of a self-made skill (no-op for curated ones). */
  noteUse(name: string): void {
    recordSelfMadeUse(this.skillsDir, name);
  }

  getSkillSummariesText(): string {
    const skills = this.getDiscovered();
    if (skills.length === 0) return '';
    const sharedNames = new Set(skills.filter((s) => s.shared).map((s) => s.name));
    const own = skills.filter((s) => !s.shared);

    // Group skills by category using IntentRouter
    const categories = this.intentRouter.getAllCategories();
    const hasCategories = categories.size > 0;

    let text = '**Available Skills** (invoke with the `use_skill` tool):\n';

    if (hasCategories && categories.size > 1) {
      // Group by category. A skill in several categories is listed once,
      // under the first (every line here is re-sent with each request).
      const listed = new Set<string>();
      for (const [category, catSkills] of categories) {
        const fresh = catSkills.filter((s) => !listed.has(s.name) && !sharedNames.has(s.name));
        if (fresh.length === 0) continue;
        const label = category === SELF_MADE_CATEGORY ? SELF_MADE_LABEL : getCategoryLabel(category);
        text += `\n**${label}:**\n`;
        for (const s of fresh) {
          listed.add(s.name);
          const discovered = this.discovered.get(s.name);
          const desc = discovered?.description || s.description;
          text += `- ${s.name}: ${desc}\n`;
        }
      }
    } else {
      // Flat list (no categorization or only one category)
      text += own.map(s => `- ${s.name}: ${s.description}`).join('\n');
    }

    // Skills other agents share, compactly: a family (hyperframes, hyperframes-core, …) is one line.
    const shared = skills.filter((s) => s.shared).sort((a, b) => a.name.localeCompare(b.name));
    if (shared.length) {
      text += '\n\n**Shared skills** (installed for other agents too; load the same way):\n';
      const children = new Map<string, string[]>();
      const heads = shared.filter((s) => !shared.some((p) => p !== s && s.name.startsWith(`${p.name}-`)));
      for (const s of shared) {
        const head = heads.find((h) => h !== s && s.name.startsWith(`${h.name}-`));
        if (head) children.set(head.name, [...(children.get(head.name) ?? []), s.name]);
      }
      for (const h of heads) {
        const kids = children.get(h.name);
        text += `- ${h.name}: ${briefDescription(h.description)}${kids?.length ? ` (with ${kids.join(', ')})` : ''}\n`;
      }
    }

    // Skills are optional procedures, never a gate in front of the answer
    // (ADR-039). These lines used to say "you MUST invoke the web-search
    // skill immediately" and "MUST invoke tweet-notifier", which pulled every
    // model toward a skill even for local questions ("which Docker
    // containers are running?").
    const hasWebSearchSkill = skills.some(s => s.name === 'web-search');
    if (hasWebSearchSkill) {
      text += '\n\n**Current information:** for news, prices or anything newer than your training data, look it up '
        + '(the web_search tool, or the `web-search` skill when you want its full procedure) instead of answering from memory. '
        + 'Questions about this computer, its files or programs are not web questions.';
    }

    text += '\n\n**Using skills** — When a request clearly matches a skill, invoke it via `use_skill`. '
      + 'A skill is optional help, not a requirement: if none fits, just do the task. '
      + 'If the request could match several skills equally, pick the best fit or ask with `ask_user`. '
      + 'A message that starts with `#skill-name` means the user already picked that skill.'
      + '\n\n**When the user names a skill, tool or service** ("use hyperframes", "with ElevenLabs", "render it with Remotion"), that is the method: '
      + 'load the skill whose name matches, even written loosely ("hyperframe", "hyper frames"), follow it to the finished file (render it, don\'t stop at the source), '
      + 'and pass the named service to the media tools. Never swap in a different method (an AI video model for a HyperFrames render, Google for ElevenLabs) on your own: '
      + 'if the named one isn\'t available or fails, say so and ask. It holds for the rest of the chat, not only the message that named it.';

    return text;
  }

  saveSkill(name: string, content: string): string {
    const skillDir = this.resolveSkillDir(name);
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }
    writeFileSync(join(skillDir, SKILL_FILE), content, 'utf-8');
    const disabledPath = join(skillDir, DISABLED_FILE);
    if (existsSync(disabledPath)) {
      unlinkSync(disabledPath);
    }
    logger.info({ skill: name }, 'Skill saved');
    this.discover();
    return skillDir;
  }

  /**
   * Resolve a skill name to its directory inside the skills root. Rejects
   * empty names and names that escape the root (absolute paths, `..`
   * traversal), so a remote SKILL.md frontmatter `name` cannot cause writes
   * outside `skillsDir`.
   */
  private resolveSkillDir(name: string): string {
    const trimmed = (name ?? '').trim();
    const root = resolve(this.skillsDir);
    const candidate = resolve(root, trimmed);
    if (!trimmed || candidate === root || !candidate.startsWith(root + sep)) {
      throw new Error(`Invalid skill name ${JSON.stringify(name)}: resolves outside the skills root`);
    }
    return candidate;
  }

  getAllSkills(): Array<SkillDiscovery & { active: boolean }> {
    const list: Array<SkillDiscovery & { active: boolean }> = [];
    if (!existsSync(this.skillsDir)) return list;

    // Include disabled too — walk both layouts but don't honor .disabled here.
    const candidates = this.walkAllSkillPaths();
    for (const { skillPath, disabled } of candidates) {
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed) continue;
        list.push({
          name: parsed.meta.name,
          description: parsed.meta.description,
          ...(parsed.meta.category ? { category: parsed.meta.category } : {}),
          active: !disabled,
        });
      } catch (err) {
        logger.warn({ err, path: skillPath }, 'Failed to read skill metadata');
      }
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  setSkillActive(name: string, active: boolean): boolean {
    const entry = this.findSkillEntryByName(name);
    if (!entry) return false;
    const disabledPath = join(entry.skillDir, DISABLED_FILE);
    if (active) {
      if (existsSync(disabledPath)) unlinkSync(disabledPath);
    } else {
      writeFileSync(disabledPath, 'disabled\n', 'utf-8');
    }
    this.discover();
    return true;
  }

  deleteSkill(name: string): boolean {
    const entry = this.findSkillEntryByName(name);
    if (!entry) return false;
    rmSync(entry.skillDir, { recursive: true, force: true });
    this.discover();
    logger.info({ skill: name }, 'Skill deleted');
    return true;
  }

  async installFromUrl(url: string): Promise<{ name: string; skillDir: string }> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch skill from URL: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    return this.installFromContent(content);
  }

  installFromContent(content: string): { name: string; skillDir: string } {
    const parsed = parseSkillMd(content);
    if (!parsed) {
      throw new Error('Invalid SKILL.md: missing or malformed YAML frontmatter with name and description');
    }
    const skillDir = this.saveSkill(parsed.meta.name, content);
    return { name: parsed.meta.name, skillDir };
  }

  private findSkillEntryByName(name: string): { skillDir: string } | null {
    if (!existsSync(this.skillsDir)) return null;
    const candidates = this.walkAllSkillPaths();
    let lastMatch: string | null = null;
    for (const { skillPath } of candidates) {
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (parsed?.meta.name === name) {
          lastMatch = join(skillPath, '..');
        }
      } catch {
        continue;
      }
    }
    return lastMatch ? { skillDir: lastMatch } : null;
  }

  /** Like findSkillFiles, but also returns disabled entries (used by getAllSkills). */
  private walkAllSkillPaths(): Array<{ skillPath: string; disabled: boolean }> {
    const out: Array<{ skillPath: string; disabled: boolean }> = [];
    if (!existsSync(this.skillsDir)) return out;
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const dir = join(this.skillsDir, entry.name);
      const flat = join(dir, SKILL_FILE);
      if (existsSync(flat)) {
        out.push({ skillPath: flat, disabled: existsSync(join(dir, DISABLED_FILE)) });
        continue;
      }
      let children: import('node:fs').Dirent[] = [];
      try { children = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('_') || child.name.startsWith('.')) continue;
        const childDir = join(dir, child.name);
        const nested = join(childDir, SKILL_FILE);
        if (existsSync(nested)) {
          out.push({ skillPath: nested, disabled: existsSync(join(childDir, DISABLED_FILE)) });
        }
      }
    }
    return out;
  }

  private seedTemplate(): void {
    const templateDir = join(this.skillsDir, '_template');
    mkdirSync(templateDir, { recursive: true });

    const content = `---
name: template-skill
description: A template skill for Mercury. Use this as a starting point to create your own skills.
version: 0.1.0
category: development
tags:
  - template
allowed-tools:
  - read_file
  - list_dir
---

# Template Skill

This is a template skill for Mercury. Copy this directory and edit SKILL.md to create your own skill.

## What It Does

Describe what this skill enables Mercury to do. When invoked via the use_skill tool, these instructions are injected into Mercury's context as guidance.

## Instructions

1. Step one of what Mercury should do
2. Step two
3. Continue with specific guidance

## Tips

- Keep instructions concise to save tokens
- List only the tools you need in allowed-tools
- The skill name must be unique among installed skills
- Add \`category\` and \`tags\` in frontmatter to group the skill in lists; the description is what Mercury reads to decide when to use it
`;

    writeFileSync(join(templateDir, SKILL_FILE), content, 'utf-8');
    logger.info('Seeded template skill');
  }

  /**
   * Built-in skills Mercury no longer ships (ADR-040). A copy that is byte
   * for byte one Mercury seeded was never touched by the owner: it moves to
   * `_retired-<name>` (underscore folders are not loaded, nothing is
   * deleted). An edited copy is the owner's own skill and stays where it is.
   */
  private retireOldDefaults(): void {
    for (const [dirName, hashes] of Object.entries(RETIRED_SEEDS)) {
      const skillDir = join(this.skillsDir, dirName);
      const skillFile = join(skillDir, SKILL_FILE);
      if (!existsSync(skillFile)) continue;
      try {
        const hash = createHash('sha256').update(readFileSync(skillFile)).digest('hex');
        if (!hashes.includes(hash)) continue;
        let target = join(this.skillsDir, `_retired-${dirName}`);
        if (existsSync(target)) target = `${target}-${Date.now()}`;
        renameSync(skillDir, target);
        logger.info({ skill: dirName, movedTo: target }, 'Retired a built-in skill Mercury no longer ships');
      } catch (err) {
        logger.warn({ err, skill: dirName }, 'Could not retire an old built-in skill');
      }
    }
  }

  /**
   * Defaults are installed once (ADR-040). Which ones were installed is kept
   * in `.seeded-defaults.json`, so a default the owner deletes stays deleted
   * instead of coming back on the next start; a new default Mercury adds
   * later is still installed once.
   */
  private readSeededDefaults(): Set<string> {
    try {
      const parsed = JSON.parse(readFileSync(join(this.skillsDir, SEEDED_FILE), 'utf-8')) as { seeded?: unknown };
      return new Set(Array.isArray(parsed.seeded) ? parsed.seeded.filter((n): n is string => typeof n === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private writeSeededDefaults(seeded: Set<string>): void {
    try {
      writeFileSync(join(this.skillsDir, SEEDED_FILE), JSON.stringify({ seeded: [...seeded].sort() }, null, 2) + '\n', 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Could not record installed default skills');
    }
  }

  private ensureDefaultSkills(): void {
    const seeded = this.readSeededDefaults();
    const before = seeded.size;
    for (const seed of DEFAULT_SKILL_SEEDS) {
      const skillDir = join(this.skillsDir, seed.dirName);
      const skillFile = join(skillDir, seed.fileName);
      if (existsSync(skillFile)) {
        seeded.add(seed.dirName);
        // Upgrade an untouched copy of an older built-in version; never overwrite edits.
        try {
          const current = readFileSync(skillFile, 'utf-8');
          if (current !== seed.content && (PREVIOUS_SEED_CONTENTS[seed.dirName] ?? []).includes(current)) {
            writeFileSync(skillFile, seed.content, 'utf-8');
            logger.info({ skill: seed.dirName }, 'Upgraded default skill');
          } else if (current !== seed.content && isBrokenSearchSkill(seed.dirName, current)) {
            // A web-search skill that scrapes a search engine's HTML page
            // (usually DuckDuckGo, which now answers bots with a challenge)
            // never works. Keep the owner's copy beside it and use the
            // built-in one, which calls the web_search tool.
            writeFileSync(`${skillFile}.replaced.bak`, current, 'utf-8');
            writeFileSync(skillFile, seed.content, 'utf-8');
            logger.info({ skill: seed.dirName, backup: `${skillFile}.replaced.bak` }, 'Replaced a web-search skill that scrapes a blocked search page');
          }
        } catch { /* leave it */ }
        continue;
      }

      // Installed before and gone now: the owner removed it. Leave it removed.
      if (seeded.has(seed.dirName)) continue;
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, seed.content, 'utf-8');
      seeded.add(seed.dirName);
      logger.info({ skill: seed.dirName }, 'Seeded default skill');
    }
    if (seeded.size !== before) this.writeSeededDefaults(seeded);
  }
}
