import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from './loader.js';
import { DEFAULT_SKILL_SEEDS, RETIRED_SEEDS } from './default-skills.js';

/**
 * ADR-040: Mercury ships one default skill (web-search). Copies of the old
 * defaults it seeded (tweet-notifier, screenshot) that the owner never
 * edited are moved aside — not deleted — and never come back; edited copies
 * are the owner's and stay.
 */
describe('default skills', () => {
  let root: string;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const original = structuredClone(RETIRED_SEEDS);

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mercury-default-skills-')); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const k of Object.keys(RETIRED_SEEDS)) delete RETIRED_SEEDS[k];
    Object.assign(RETIRED_SEEDS, original);
  });

  const DEFAULTS = ['web-search', 'computer-health', 'tidy-files', 'data-analysis', 'long-documents', 'documents'];

  it('ships the generic defaults, and a fresh install gets exactly those', () => {
    expect(DEFAULT_SKILL_SEEDS.map((s) => s.dirName)).toEqual(DEFAULTS);
    const names = new SkillLoader(join(root, 'skills')).discover().map((s) => s.name).sort();
    expect(names).toEqual([...DEFAULTS].sort());
  });

  it('every default parses, says when to use it, and grants nothing (approval stays on)', () => {
    const loader = new SkillLoader(join(root, 'skills'));
    loader.discover();
    for (const name of DEFAULTS) {
      const skill = loader.load(name);
      expect(skill, name).toBeTruthy();
      expect(skill!.description.length, name).toBeGreaterThan(60);
      expect(skill!.instructions.length, name).toBeGreaterThan(200);
      if (name !== 'web-search') {
        // Only web-search lists tools, and only ones that need no elevation.
        expect(skill!['allowed-tools'] ?? [], name).toEqual([]);
      }
    }
    expect(loader.load('web-search')!['allowed-tools']).toEqual(['web_search', 'fetch_url']);
  });

  it('installs a default once: a deleted one stays deleted', () => {
    const dir = join(root, 'skills');
    new SkillLoader(dir).discover();
    rmSync(join(dir, 'tidy-files'), { recursive: true });
    const names = new SkillLoader(dir).discover().map((s) => s.name);
    expect(names).not.toContain('tidy-files');
    expect(existsSync(join(dir, 'tidy-files'))).toBe(false);
  });

  it('an existing install gets defaults added later, once', () => {
    const dir = join(root, 'skills');
    mkdirSync(dir, { recursive: true });
    // An install from before: web-search on disk, recorded as installed.
    const web = DEFAULT_SKILL_SEEDS.find((s) => s.dirName === 'web-search')!;
    mkdirSync(join(dir, 'web-search'));
    writeFileSync(join(dir, 'web-search', 'SKILL.md'), web.content);
    writeFileSync(join(dir, '.seeded-defaults.json'), JSON.stringify({ seeded: ['web-search'] }));
    const names = new SkillLoader(dir).discover().map((s) => s.name).sort();
    expect(names).toEqual([...DEFAULTS].sort());
    expect(JSON.parse(readFileSync(join(dir, '.seeded-defaults.json'), 'utf8')).seeded).toEqual([...DEFAULTS].sort());
  });

  it('the old defaults are listed for retirement with the hashes of what was seeded', () => {
    expect(Object.keys(RETIRED_SEEDS).sort()).toEqual(['screenshot', 'tweet-notifier']);
    for (const hashes of Object.values(RETIRED_SEEDS)) for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('moves an untouched old default aside and does not reseed it', () => {
    const untouched = '---\nname: tweet-notifier\ndescription: seeded\n---\n\nBody\n';
    RETIRED_SEEDS['tweet-notifier'] = [sha(untouched)];
    mkdirSync(join(root, 'tweet-notifier'), { recursive: true });
    writeFileSync(join(root, 'tweet-notifier', 'SKILL.md'), untouched);

    const names = new SkillLoader(root).discover().map((s) => s.name);
    expect(names).not.toContain('tweet-notifier');
    expect(names).toContain('web-search');
    expect(existsSync(join(root, 'tweet-notifier'))).toBe(false);
    // Kept, not deleted, in a folder the loader skips.
    expect(readFileSync(join(root, '_retired-tweet-notifier', 'SKILL.md'), 'utf8')).toBe(untouched);
    // A second start leaves everything as it is.
    expect(new SkillLoader(root).discover().map((s) => s.name)).not.toContain('tweet-notifier');
    expect(readdirSync(root).filter((d) => d.startsWith('_retired-'))).toEqual(['_retired-tweet-notifier']);
  });

  it("keeps an old default the owner edited — it's their skill now", () => {
    RETIRED_SEEDS.screenshot = [sha('the seeded version')];
    mkdirSync(join(root, 'screenshot'), { recursive: true });
    const edited = '---\nname: screenshot\ndescription: my own screenshot flow\n---\n\nMine.\n';
    writeFileSync(join(root, 'screenshot', 'SKILL.md'), edited);

    expect(new SkillLoader(root).discover().map((s) => s.name)).toContain('screenshot');
    expect(readFileSync(join(root, 'screenshot', 'SKILL.md'), 'utf8')).toBe(edited);
  });
});

describe('skill list in the system prompt', () => {
  it('lists every skill once, even one in several categories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-skill-list-'));
    try {
      const loader = new SkillLoader(join(dir, 'skills'));
      loader.discover();
      const text = loader.getSkillSummariesText();
      expect(text.split('- web-search:').length - 1).toBe(1);
      for (const name of ['computer-health', 'tidy-files', 'data-analysis', 'long-documents', 'documents']) {
        expect(text.split(`- ${name}:`).length - 1, name).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
