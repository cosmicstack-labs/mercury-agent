import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { SkillLoader } from './loader.js';

const root = resolve('skills/mercury-adapted');
const slugs = ['systematic-debugging', 'test-driven-development', 'verification-before-completion', 'writing-plans',
  'requesting-code-review', 'spec-compliance-review', 'document-to-action-items', 'frontend-design',
  'grounded-citations', 'rss-feeds', 'batch-ingest-quality-audits', 'linux-desktop-entry-repair',
  'skill-install-security-gate', 'skill-security-triage', 'scheduled-task-operations',
  'read-only-audit-brief', 'repository-implementation-analysis', 'resumable-batch-extraction',
  'writing-for-agents', 'simplify-changes', 'skill-fleet-audit'];
const names = slugs.map((s) => `mercury-${s}`).sort();

describe('curated Mercury adaptation pack', () => {
  it('contains exactly twenty-one unique, discoverable skills without seeding defaults', () => {
    const loader = new SkillLoader(root, { seedDefaults: false });
    expect(loader.discover().map((s) => s.name).sort()).toEqual(names);
    expect(readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length).toBe(21);
    for (const name of names) {
      const skill = loader.load(name);
      expect(skill?.version).toBe('0.1.0');
      expect(skill?.instructions.length).toBeGreaterThan(1000);
      expect(skill?.instructions).toMatch(/approval/i);
    }
  });
  it('has native metadata, attributable licensing and resolvable internal skill references', () => {
    for (const slug of slugs) {
      const content = readFileSync(join(root, slug, 'SKILL.md'), 'utf8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)!;
      expect(match, slug).not.toBeNull();
      const meta = parse(match[1]);
      expect(meta.name).toBe(`mercury-${slug}`);
      expect(meta.license).toBe('MIT');
      expect(meta.description.length).toBeGreaterThan(20);
      expect(meta.intents.length).toBeGreaterThan(0);
      expect(meta.author).toBeTruthy();
      expect(content).not.toMatch(/\b(?:terminal|search_files|web_extract)\s*\(/);
      for (const ref of match[2].matchAll(/`(mercury-[a-z-]+)`/g)) expect(names).toContain(ref[1]);
    }
  });
  it('documents review limits without treating safety review as installation authority', () => {
    const gate = readFileSync(join(root, 'skill-install-security-gate/SKILL.md'), 'utf8');
    const triage = readFileSync(join(root, 'skill-security-triage/SKILL.md'), 'utf8');
    expect(gate).toContain('Obtain exact installation approval even after PASS');
    expect(gate).toContain('missing licensing is unresolved');
    expect(gate).toContain('INCOMPLETE, never clean');
    expect(gate).toContain('Any changed payload invalidates');
    expect(triage).toContain('verifying identical relevant bytes and equivalent execution context');
    expect(triage).toContain('Independently inspect the complete shipped execution surface');
    expect(triage).toContain('A repair authorization is not an installation authorization');
    for (const content of [gate, triage]) {
      expect(content).toContain('Second Brain');
      expect(content).not.toMatch(/~\/\.hermes|skill_manage\(|skill_view\(/);
    }
  });
  it('documents scheduler limitations rather than assuming Hermes features', () => {
    const content = readFileSync(join(root, 'scheduled-task-operations/SKILL.md'), 'utf8');
    expect(content).toContain('exactly one of `cron` or `delay_seconds`');
    expect(content).toContain('no exposed timezone, paused, script/no-agent, per-job model, delivery, edit, or run-now parameter');
    expect(content).toContain('not a generic tool allowlist');
    expect(content).toContain('cancel/create is not atomic');
    expect(content).toContain('may truncate prompt text');
    expect(content).toContain('obtain exact approval before calling it');
    expect(content).toContain('Report registration, execution, output freshness, and delivery separately');
  });
  it('keeps the analysis and writing skills read-only and explicitly gated', () => {
    const brief = readFileSync(join(root, 'read-only-audit-brief/SKILL.md'), 'utf8');
    const repo = readFileSync(join(root, 'repository-implementation-analysis/SKILL.md'), 'utf8');
    const writing = readFileSync(join(root, 'writing-for-agents/SKILL.md'), 'utf8');
    const batch = readFileSync(join(root, 'resumable-batch-extraction/SKILL.md'), 'utf8');
    expect(brief).toContain('exactly one approval gate');
    expect(brief).toContain('A subagent verdict is a claim until the parent checks');
    expect(brief).toContain('Second Brain');
    expect(repo).toContain('a declaration alone is not a template');
    expect(repo).toContain('no honest precedent');
    expect(repo).toContain('never authorizes edits');
    expect(writing).toContain('Progressive disclosure');
    expect(writing).toContain('no-ops');
    expect(writing).toContain('is not an installation approval');
    expect(batch).toContain('permanent_failure');
    expect(batch).toContain('Never use route rotation to bypass authorization');
    expect(batch).toContain('Final reconciliation is the proof');
    for (const content of [brief, repo, writing, batch]) {
      expect(content).not.toMatch(/~\/\.hermes|skill_manage\(|skill_view\(|mnemosyne_remember\(/);
      expect(content).not.toMatch(/\b(?:terminal|search_files|web_extract)\s*\(/);
    }
  });
  it('keeps cleanup review risk-tiered and the fleet audit on native checks', () => {
    const simplify = readFileSync(join(root, 'simplify-changes/SKILL.md'), 'utf8');
    const fleet = readFileSync(join(root, 'skill-fleet-audit/SKILL.md'), 'utf8');
    expect(simplify).toContain('This is a cleanup pass on code that already works, not a bug hunt');
    expect(simplify).toContain('RISKY');
    expect(simplify).toContain('Chesterton');
    expect(simplify).toContain('ran as a fan-out or inline');
    expect(fleet).toContain('No external evaluator is bundled or required');
    expect(fleet).toContain('seedDefaults: false');
    expect(fleet).toContain('Passing checks prove the files parse and install');
    expect(fleet).toContain('Never hide a failing skill inside an average score');
    for (const content of [simplify, fleet]) {
      expect(content).not.toMatch(/~\/\.hermes|skill_manage\(|skill_view\(|mnemosyne_remember\(/);
      expect(content).not.toMatch(/\b(?:terminal|search_files|web_extract)\s*\(/);
    }
  });
  it('installs identical content into an isolated skill root and reloads it', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'mercury-adapted-skills-'));
    try {
      const loader = new SkillLoader(isolated, { seedDefaults: false });
      for (const slug of slugs) {
        const content = readFileSync(join(root, slug, 'SKILL.md'), 'utf8');
        const installed = loader.installFromContent(content);
        expect(readFileSync(join(installed.skillDir, 'SKILL.md'), 'utf8')).toBe(content);
        expect(loader.load(installed.name)?.name).toBe(`mercury-${slug}`);
      }
      expect(loader.discover().map((s) => s.name).sort()).toEqual(names);
    } finally { rmSync(isolated, { recursive: true, force: true }); }
  });
});
