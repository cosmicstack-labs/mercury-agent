import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillManifest } from './types.js';
import { logger } from '../utils/logger.js';

export class SkillLoader {
  private skillsDir: string;
  private manifests: Map<string, SkillManifest> = new Map();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(process.cwd(), 'skills');
  }

  discover(): SkillManifest[] {
    this.manifests.clear();
    if (!existsSync(this.skillsDir)) return [];

    const entries = readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const manifestPath = join(this.skillsDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest: SkillManifest = JSON.parse(raw);
        this.manifests.set(manifest.name, manifest);
        logger.info({ skill: manifest.name }, 'Skill discovered');
      } catch (err) {
        logger.warn({ dir: entry.name, err }, 'Failed to load skill manifest');
      }
    }

    return [...this.manifests.values()];
  }

  getManifest(name: string): SkillManifest | undefined {
    return this.manifests.get(name);
  }

  getAllManifests(): SkillManifest[] {
    return [...this.manifests.values()];
  }
}