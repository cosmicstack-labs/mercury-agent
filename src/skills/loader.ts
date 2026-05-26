import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import type { SkillDiscovery, Skill, SkillMeta } from './types.js';
import { IntentRouter } from './intent-router.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_SKILL_SEEDS, getCategoryLabel } from './default-skills.js';

const SKILL_FILE = 'SKILL.md';
const DISABLED_FILE = '.disabled';

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
  private discovered: Map<string, SkillDiscovery> = new Map();
  private loaded: Map<string, Skill> = new Map();
  readonly intentRouter: IntentRouter;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(getMercuryHome(), 'skills');
    this.intentRouter = new IntentRouter();
  }

  discover(): SkillDiscovery[] {
    this.discovered.clear();
    this.loaded.clear();
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
      this.seedTemplate();
    }

    this.ensureDefaultSkills();

    // Walk both layouts:
    //   - flat:   <skillsDir>/<name>/SKILL.md            (legacy + user-authored)
    //   - nested: <skillsDir>/<category>/<slug>/SKILL.md (mercury skills install)
    // User-installed nested skills win over flat ones on name collision (registered last).
    const skillPaths = this.findSkillFiles();
    for (const skillPath of skillPaths) {
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed) continue;
        this.discovered.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
        });
        this.intentRouter.registerSkillMeta(parsed.meta);
        logger.info({ skill: parsed.meta.name, path: skillPath, category: parsed.meta.category, intents: parsed.meta.intents?.length }, 'Skill discovered');
      } catch (err) {
        logger.warn({ path: skillPath, err }, 'Failed to load skill');
      }
    }

    // Build intent index from discovered skills (basic info for fallback matching)
    this.intentRouter.buildIndex([...this.discovered.values()]);

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
    if (!existsSync(this.skillsDir)) return out;

    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const dir = join(this.skillsDir, entry.name);
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

  getSkillSummariesText(): string {
    const skills = this.getDiscovered();
    if (skills.length === 0) return '';

    // Group skills by category using IntentRouter
    const categories = this.intentRouter.getAllCategories();
    const hasCategories = categories.size > 0;

    let text = '**Available Skills** (invoke with the `use_skill` tool):\n';

    if (hasCategories && categories.size > 1) {
      // Group by category
      for (const [category, catSkills] of categories) {
        const label = getCategoryLabel(category);
        text += `\n**${label}:**\n`;
        for (const s of catSkills) {
          const discovered = this.discovered.get(s.name);
          const desc = discovered?.description || s.description;
          text += `- ${s.name}: ${desc}\n`;
        }
      }
    } else {
      // Flat list (no categorization or only one category)
      text += skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    }

    // Auto-routing hint for web search
    const hasWebSearchSkill = skills.some(s => s.name === 'web-search');
    if (hasWebSearchSkill) {
      text += '\n\n**Important — Web Search:** When the user asks about current events, news, real-time information, '
        + 'or anything that requires up-to-date knowledge beyond your training data, you MUST invoke the `web-search` skill '
        + 'via `use_skill` immediately — do NOT attempt to answer from memory or ask clarifying questions first. '
        + 'Fetch real information, then respond.';
    }

    // Auto-routing hint for tweet-notifier
    const hasTweetNotifier = skills.some(s => s.name === 'tweet-notifier');
    if (hasTweetNotifier) {
      text += '\n\n**Tweet Notification System:** When the user says things like '
        + '"schedule a tweet", "approve this tweet", "notify supporters about the tweet", '
        + '"post this tweet at 3pm", "show pending tweets", "reject tweet", or mentions '
        + 'tweet scheduling/approval/posting workflows, you MUST invoke the `tweet-notifier` skill '
        + 'via `use_skill` before proceeding. The skill contains complete notification templates, '
        + 'workflow steps, and the memory schema for tracking tweet states (draft, scheduled, '
        + 'pending_approval, approved, posted, cancelled).';
    }

    // Intent routing hint — tell the agent about the new system
    text += '\n\n**Skill Intent Routing Available** — When a user request matches skill intents, '
      + 'you can use intent matching to automatically route to the right skills. '
      + 'For multi-skill requests, batch execution across sub-agents for parallel processing.';

    return text;
  }

  saveSkill(name: string, content: string): string {
    const skillDir = join(this.skillsDir, name);
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
- Add \`category\`, \`categories\`, \`intents\`, and \`tags\` in frontmatter for automatic intent routing
`;

    writeFileSync(join(templateDir, SKILL_FILE), content, 'utf-8');
    logger.info('Seeded template skill');
  }

  private ensureDefaultSkills(): void {
    for (const seed of DEFAULT_SKILL_SEEDS) {
      const skillDir = join(this.skillsDir, seed.dirName);
      const skillFile = join(skillDir, seed.fileName);
      if (existsSync(skillFile)) continue;

      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, seed.content, 'utf-8');
      logger.info({ skill: seed.dirName }, 'Seeded default skill');
    }
  }
}
