import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { createUseSkillTool } from '../capabilities/skills/use-skill.js';
import type { PermissionManager } from '../capabilities/permissions.js';
import { SkillLoader } from './loader.js';

const root = resolve(import.meta.dirname, '../../skills/mercury-adapted');
const slugs = [
  'agent-workstation-backup-recovery', 'deterministic-release-zip-builder',
  'document-text-extraction', 'file-organization', 'image-pdf-production',
  'mcp-server-patterns', 'shell-wrapper-reliability', 'tabular-data-processing',
  'video-editing',
];
const names = slugs.map((slug) => `mercury-${slug}`).sort();

describe('native Mercury workflow pack', () => {
  it('discovers exactly the reviewed inventory without seeding default skills', () => {
    const loader = new SkillLoader(root, { seedDefaults: false });
    expect(loader.discover().map((skill) => skill.name).sort()).toEqual(names);
    expect(readdirSync(root).sort()).toEqual(['LICENSE', 'README.md', ...slugs].sort());
    for (const slug of slugs) {
      // No hidden executables, reference payloads or third-party assets.
      expect(readdirSync(join(root, slug))).toEqual(['SKILL.md']);
    }
  });

  it('retains the repository license and native metadata without permission grants', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8'))
      .toBe(readFileSync(resolve(root, '../../LICENSE'), 'utf8'));
    for (const slug of slugs) {
      const content = readFileSync(join(root, slug, 'SKILL.md'), 'utf8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)!;
      expect(match, slug).not.toBeNull();
      const meta = parse(match[1]);
      expect(meta.name).toBe(`mercury-${slug}`);
      expect(meta.id).toBe(`${meta.category}/${slug}`);
      expect(meta.version).toBe('0.2.0');
      expect(meta.license).toBe('MIT');
      expect(meta.author).toBe('Cosmic Stack');
      expect(meta.description.length).toBeGreaterThan(20);
      expect(meta.intents.length).toBeGreaterThan(0);
      expect(meta['allowed-tools']).toEqual([]);
      expect(match[2].length).toBeGreaterThan(1000);
      expect(match[2]).toContain('Loading this skill grants no tool permissions.');
      expect(match[2]).toContain('Second Brain');
      expect(match[2]).toMatch(/approval/i);
      expect(content).not.toMatch(/~\/\.hermes|skill_manage\(|skill_view\(|mnemosyne_remember\(/);
      for (const reference of match[2].matchAll(/`(mercury-[a-z-]+)`/g)) {
        expect(names, slug).toContain(reference[1]);
      }
    }
  });

  it('invokes every shipped skill without requesting permission elevation', async () => {
    const loader = new SkillLoader(root, { seedDefaults: false });
    const elevateForSkill = vi.fn();
    const permissions = { elevateForSkill } as unknown as PermissionManager;
    const useSkill = createUseSkillTool(loader, permissions);
    for (const name of names) {
      const result = await useSkill.execute!({ name }, { toolCallId: name, messages: [] });
      expect(result).toContain(`## Skill: ${name}`);
      expect(result).not.toContain('Allowed tools:');
    }
    expect(elevateForSkill).not.toHaveBeenCalled();
  });

  it('installs and reloads identical files in an isolated profile', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'mercury-native-pack-'));
    try {
      const loader = new SkillLoader(isolated, { seedDefaults: false });
      for (const slug of slugs) {
        const content = readFileSync(join(root, slug, 'SKILL.md'), 'utf8');
        const installed = loader.installFromContent(content);
        expect(readFileSync(join(installed.skillDir, 'SKILL.md'), 'utf8')).toBe(content);
        expect(loader.load(installed.name)?.['allowed-tools']).toEqual([]);
      }
      expect(loader.discover().map((skill) => skill.name).sort()).toEqual(names);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
