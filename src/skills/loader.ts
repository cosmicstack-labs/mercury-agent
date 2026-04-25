import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import type { SkillDiscovery, Skill, SkillMeta } from './types.js';
import { logger } from '../utils/logger.js';

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

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(getMercuryHome(), 'skills');
  }

  discover(): SkillDiscovery[] {
    this.discovered.clear();
    this.loaded.clear();
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
      this.seedTemplate();
      return [];
    }

    const entries = readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const skillDir = join(this.skillsDir, entry.name);
      if (existsSync(join(skillDir, DISABLED_FILE))) continue;
      const skillPath = join(this.skillsDir, entry.name, SKILL_FILE);
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed) continue;
        this.discovered.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
        });
        logger.info({ skill: parsed.meta.name }, 'Skill discovered');
      } catch (err) {
        logger.warn({ dir: entry.name, err }, 'Failed to load skill');
      }
    }

    return [...this.discovered.values()];
  }

  load(name: string): Skill | null {
    const cached = this.loaded.get(name);
    if (cached) return cached;

    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const skillDir = join(this.skillsDir, entry.name);
      if (existsSync(join(skillDir, DISABLED_FILE))) continue;
      const skillPath = join(this.skillsDir, entry.name, SKILL_FILE);
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed || parsed.meta.name !== name) continue;

        const skill: Skill = {
          ...parsed.meta,
          instructions: parsed.instructions,
          scriptsDir: existsSync(join(skillDir, 'scripts')) ? join(skillDir, 'scripts') : undefined,
          referencesDir: existsSync(join(skillDir, 'references')) ? join(skillDir, 'references') : undefined,
        };
        this.loaded.set(name, skill);
        return skill;
      } catch (err) {
        logger.warn({ err, name }, 'Failed to load skill');
        return null;
      }
    }

    return null;
  }

  getDiscovered(): SkillDiscovery[] {
    return [...this.discovered.values()];
  }

  getSkillSummariesText(): string {
    const skills = this.getDiscovered();
    if (skills.length === 0) return '';
    return 'Available skills:\n' + skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
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

    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const skillDir = join(this.skillsDir, entry.name);
      const skillPath = join(skillDir, SKILL_FILE);
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (!parsed) continue;
        list.push({
          name: parsed.meta.name,
          description: parsed.meta.description,
          active: !existsSync(join(skillDir, DISABLED_FILE)),
        });
      } catch (err) {
        logger.warn({ err, dir: entry.name }, 'Failed to read skill metadata');
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
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const skillDir = join(this.skillsDir, entry.name);
      const skillPath = join(skillDir, SKILL_FILE);
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const parsed = parseSkillMd(raw);
        if (parsed?.meta.name === name) {
          return { skillDir };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private seedTemplate(): void {
    const templateDir = join(this.skillsDir, '_template');
    mkdirSync(templateDir, { recursive: true });

    const content = `---
name: template-skill
description: A template skill for Mercury. Use this as a starting point to create your own skills.
version: 0.1.0
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
`;

    writeFileSync(join(templateDir, SKILL_FILE), content, 'utf-8');
    logger.info('Seeded template skill');
  }
}
