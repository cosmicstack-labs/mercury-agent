import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillLoader } from './loader.js';
import {
  DORMANT_AFTER_DAYS, MAX_SELF_MADE, SELF_MADE_CATEGORY, SELF_MADE_LABEL, composeSkillMd, listSelfMade, readSelfMadeMeta, recordSelfMadeUse,
  rejectDraft, selfMadeHygiene, slugify, type SelfMadeDraft,
} from './self-made.js';
import { createCreateSkillTool } from '../capabilities/skills/create-skill.js';

const dirs: string[] = [];
const DAY = 86_400_000;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-selfmade-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const good: SelfMadeDraft = {
  name: 'Weekly Sales Report',
  description: 'Build the weekly sales PDF from the Google Sheet export and mail it to the founders.',
  intents: ['make the weekly sales report', 'send the sales PDF'],
  instructions: [
    '## Steps',
    '1. Ask for the week if not given; default to the last full week (Mon–Sun).',
    '2. Export the sheet: run_command `gsheet export --id $SHEET --range Sales!A:F --csv /tmp/sales.csv`.',
    '3. Build the PDF: `python3 scripts/report.py /tmp/sales.csv --week <week> --out /tmp/sales-<week>.pdf`.',
    '4. Check: the PDF opens, has one page per region, and the total matches the sheet footer.',
    '5. Mail it with send_message to the founders group; subject "Sales <week>".',
    '## Pitfalls',
    '- The sheet export fails silently when the range name has a space; quote it.',
  ].join('\n'),
  verified: 'PDF had 4 region pages, total 12,340 matched the sheet footer, mail delivered',
};

describe('self-made skills (ADR-027)', () => {
  it('slugs names and rejects drafts that are not real procedures', () => {
    expect(slugify('Weekly Sales Report')).toBe('weekly-sales-report');
    expect(slugify('!!')).toBeNull();
    expect(rejectDraft(good)).toBeNull();
    expect(rejectDraft({ ...good, instructions: 'run the thing' })).toMatch(/too short/);
    expect(rejectDraft({ ...good, intents: [] })).toMatch(/intent/);
    expect(rejectDraft({ ...good, verified: '' })).toMatch(/verified/);
    expect(rejectDraft({ ...good, instructions: good.instructions + '\nuse api key sk-abcdefghijklmnopqrstuvwxyz0123' })).toMatch(/credential/);
    expect(rejectDraft({ ...good, instructions: 'x'.repeat(300) })).toMatch(/procedure/);
  });

  it('composes a SKILL.md in the self-made category and keeps made/uses across an update', () => {
    const md = composeSkillMd(good, undefined, Date.parse('2026-10-24T10:00:00Z'));
    const meta = readSelfMadeMeta(md)!;
    expect(meta.name).toBe('weekly-sales-report');
    expect(meta.category).toBe(SELF_MADE_CATEGORY);
    expect(meta.origin).toBe('mercury');
    expect(meta.made).toBe('2026-10-24T10:00:00.000Z');
    expect(meta.uses).toBe(0);
    expect(md).toContain('## Steps');
    const updated = readSelfMadeMeta(composeSkillMd({ ...good, verified: 'again' }, { made: meta.made, uses: 3, last_used: '2026-11-01T00:00:00.000Z' }))!;
    expect(updated.made).toBe(meta.made);
    expect(updated.uses).toBe(3);
    expect(updated.last_used).toBe('2026-11-01T00:00:00.000Z');
  });

  it('create_skill saves under self-made, refuses to shadow a curated skill, and the loader lists it under its own label', async () => {
    const dir = root();
    const loader = new SkillLoader(dir, { seedDefaults: false });
    loader.saveSkill('curated', '---\nname: curated\ndescription: A curated skill the owner installed\ncategory: development\nintents:\n  - run curated\n---\n# Curated\n1. do it\n');
    const tool = createCreateSkillTool(loader);
    const exec = (tool as unknown as { execute: (args: unknown) => Promise<string> }).execute;

    expect(await exec({ ...good, name: 'curated' })).toMatch(/already an installed skill/);
    expect(await exec({ ...good, instructions: 'too short' })).toMatch(/Not saved/);
    const saved = await exec(good);
    expect(saved).toMatch(/saved/);
    expect(existsSync(join(dir, SELF_MADE_CATEGORY, 'weekly-sales-report', 'SKILL.md'))).toBe(true);

    const loaded = loader.load('weekly-sales-report')!;
    expect(loaded.category).toBe(SELF_MADE_CATEGORY);
    expect(loaded.instructions).toContain('## Steps');
    expect(loader.getSkillSummariesText()).toContain(SELF_MADE_LABEL);

    expect(await exec({ ...good, verified: 'ran twice more, totals matched' })).toMatch(/updated/);
    expect(listSelfMade(dir)).toHaveLength(1);
  });

  it('counts uses and lets unused skills go dormant without deleting them', () => {
    const dir = root();
    const loader = new SkillLoader(dir, { seedDefaults: false });
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    loader.saveSkill(`${SELF_MADE_CATEGORY}/weekly-sales-report`, composeSkillMd(good, undefined, t0));
    loader.saveSkill(`${SELF_MADE_CATEGORY}/old-unused`, composeSkillMd({ ...good, name: 'old-unused' }, undefined, t0 - 40 * DAY));

    expect(recordSelfMadeUse(dir, 'weekly-sales-report', t0 + DAY)).toBe(true);
    expect(recordSelfMadeUse(dir, 'nope')).toBe(false);
    const used = listSelfMade(dir).find((s) => s.name === 'weekly-sales-report')!;
    expect(used.uses).toBe(1);
    expect(used.lastUsed).toBe(t0 + DAY);
    // The file is still a valid skill after the frontmatter rewrite.
    expect(loader.load('weekly-sales-report')?.instructions).toContain('## Steps');

    const { dormant } = selfMadeHygiene(dir, t0 + 2 * DAY);
    expect(dormant).toEqual(['old-unused']);
    expect(existsSync(join(dir, SELF_MADE_CATEGORY, 'old-unused', 'SKILL.md'))).toBe(true);
    expect(listSelfMade(dir).find((s) => s.name === 'old-unused')?.active).toBe(false);
    // A used one survives well past the dormancy window.
    expect(selfMadeHygiene(dir, t0 + (DORMANT_AFTER_DAYS + 5) * DAY).dormant).toEqual([]);
    expect(readFileSync(join(dir, SELF_MADE_CATEGORY, 'old-unused', '.disabled'), 'utf-8')).toMatch(/never used/);
  });

  it('caps the shelf: beyond the limit, the least recently used go dormant', () => {
    const dir = root();
    const loader = new SkillLoader(dir, { seedDefaults: false });
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    for (let i = 0; i < MAX_SELF_MADE + 2; i++) {
      loader.saveSkill(`${SELF_MADE_CATEGORY}/skill-${i}`, composeSkillMd({ ...good, name: `skill-${i}` }, undefined, t0 - i * 60_000));
      recordSelfMadeUse(dir, `skill-${i}`, t0 + (MAX_SELF_MADE + 2 - i) * 60_000);
    }
    const { dormant } = selfMadeHygiene(dir, t0 + DAY);
    expect(dormant.sort()).toEqual([`skill-${MAX_SELF_MADE}`, `skill-${MAX_SELF_MADE + 1}`].sort());
  });
});
