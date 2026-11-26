import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from './loader.js';
import { BUNDLED_SKILLS } from './bundled-skills.generated.js';

describe('bundled skills (built-ins with their own files)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mercury-bundled-skills-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const dir = () => join(root, 'skills', 'any-to-pdf');

  it('the generated module matches src/skills/bundled/', () => {
    expect(() => execFileSync('node', ['scripts/gen-bundled-skills.cjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('stays small: the whole bundle adds under 150 KB', () => {
    const bytes = BUNDLED_SKILLS.reduce((n, s) => n + Object.values(s.files).reduce((m, f) => m + f.length, 0), 0);
    expect(bytes).toBeLessThan(150 * 1024);
  });

  it('any-to-pdf installs with its converter, launcher and license, and loads with its folder', () => {
    const loader = new SkillLoader(join(root, 'skills'));
    loader.discover();
    for (const f of ['SKILL.md', 'scripts/any2pdf.py', 'scripts/md2pdf.py', 'scripts/LICENSE-md2pdf.txt', 'references/themes.md']) {
      expect(existsSync(join(dir(), f)), f).toBe(true);
    }
    const skill = loader.load('any-to-pdf');
    expect(skill?.scriptsDir).toBe(join(dir(), 'scripts'));
    expect(skill?.instructions ?? '').toContain('scripts/any2pdf.py');
  });

  it('a deleted copy stays deleted; a missing file is put back; an edited file is kept', () => {
    new SkillLoader(join(root, 'skills')).discover();
    rmSync(join(dir(), 'scripts', 'md2pdf.py'));
    writeFileSync(join(dir(), 'SKILL.md'), readFileSync(join(dir(), 'SKILL.md'), 'utf-8') + '\nMy note.\n');
    new SkillLoader(join(root, 'skills')).discover();
    expect(existsSync(join(dir(), 'scripts', 'md2pdf.py'))).toBe(true);
    expect(readFileSync(join(dir(), 'SKILL.md'), 'utf-8')).toContain('My note.');
    rmSync(dir(), { recursive: true });
    new SkillLoader(join(root, 'skills')).discover();
    expect(existsSync(dir())).toBe(false);
  });

  it('an untouched file from an older version is upgraded', () => {
    new SkillLoader(join(root, 'skills')).discover();
    const launcher = join(dir(), 'scripts', 'any2pdf.py');
    // Simulate an older Mercury having written a different launcher.
    writeFileSync(launcher, '# old version\n');
    const record = JSON.parse(readFileSync(join(dir(), '.bundled.json'), 'utf-8'));
    record.files['scripts/any2pdf.py'] = createHash('sha256').update('# old version\n').digest('hex');
    writeFileSync(join(dir(), '.bundled.json'), JSON.stringify(record));
    new SkillLoader(join(root, 'skills')).discover();
    expect(readFileSync(launcher, 'utf-8')).toBe(BUNDLED_SKILLS.find((s) => s.dirName === 'any-to-pdf')!.files['scripts/any2pdf.py']);
  });
});
