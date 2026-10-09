import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requireCjs = createRequire(import.meta.url);
const ratchet = requireCjs('./lint-ratchet.cjs') as {
  countByRule: (results: unknown[]) => Record<string, number>;
  compareCounts: (
    current: Record<string, number>,
    baseline: Record<string, number>,
  ) => { rows: { rule: string; was: number; now: number; delta: number }[]; regressions: { rule: string }[]; improvements: { rule: string }[] };
  estimateCounts: (srcDir: string) => Record<string, number>;
  formatReport: (c: ReturnType<typeof ratchet.compareCounts>) => string;
  readBaseline: (file?: string) => { rules: Record<string, number>; provisional: boolean } | null;
  writeBaseline: (counts: Record<string, number>, opts: { provisional: boolean; file: string }) => { rules: Record<string, number> };
  isConsoleAllowed: (relPath: string) => boolean;
};

/**
 * The ratchet's contract: per-rule counts (errors + warnings) are compared
 * with a committed baseline and the only failing condition is growth. Any
 * rule missing from the baseline counts as 0.
 */

describe('countByRule', () => {
  it('sums warnings and errors per ruleId across files, sorted by rule', () => {
    const results = [
      { filePath: 'a.ts', messages: [{ ruleId: 'no-console', severity: 2 }, { ruleId: '@typescript-eslint/no-explicit-any', severity: 1 }] },
      { filePath: 'b.ts', messages: [{ ruleId: 'no-console', severity: 2 }] },
      { filePath: 'c.ts', messages: [] },
    ];
    const counts = ratchet.countByRule(results);
    expect(counts).toEqual({ '@typescript-eslint/no-explicit-any': 1, 'no-console': 2 });
    expect(Object.keys(counts)).toEqual(['@typescript-eslint/no-explicit-any', 'no-console']);
  });

  it('keeps parse errors (no ruleId) visible under (fatal)', () => {
    const counts = ratchet.countByRule([{ filePath: 'x.ts', messages: [{ ruleId: null, fatal: true, severity: 2 }] }]);
    expect(counts).toEqual({ '(fatal)': 1 });
  });
});

describe('compareCounts', () => {
  it('passes when every rule is equal or lower', () => {
    const c = ratchet.compareCounts({ 'no-console': 3, 'x': 0 }, { 'no-console': 5, 'x': 1 });
    expect(c.regressions).toEqual([]);
    expect(c.improvements.map((r) => r.rule)).toEqual(['no-console', 'x']);
  });

  it('fails when a rule grew, and treats a rule missing from the baseline as 0', () => {
    const c = ratchet.compareCounts({ 'no-console': 5, 'new-rule': 2 }, { 'no-console': 5 });
    expect(c.regressions.map((r) => r.rule)).toEqual(['new-rule']);
    const row = c.rows.find((r) => r.rule === 'new-rule');
    expect(row).toMatchObject({ was: 0, now: 2, delta: 2 });
    expect(ratchet.formatReport(c)).toContain('1 rule(s) grew');
  });

  it('reports an unchanged comparison as OK', () => {
    const c = ratchet.compareCounts({ a: 1 }, { a: 1 });
    expect(c.regressions).toEqual([]);
    expect(ratchet.formatReport(c)).toContain('OK (no change)');
  });
});

describe('baseline file', () => {
  it('round-trips through writeBaseline/readBaseline with sorted rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-ratchet-'));
    try {
      const file = join(dir, '.lint-baseline.json');
      ratchet.writeBaseline({ 'z-rule': 1, 'a-rule': 2 }, { provisional: true, file });
      const data = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(data.rules)).toEqual(['a-rule', 'z-rule']);
      expect(data.provisional).toBe(true);
      expect(ratchet.readBaseline(file)).toMatchObject({ provisional: true, rules: { 'a-rule': 2, 'z-rule': 1 } });
      expect(ratchet.readBaseline(join(dir, 'missing.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed .lint-baseline.json is well-formed', () => {
    const file = join(__dirname, '..', '.lint-baseline.json');
    expect(existsSync(file)).toBe(true);
    const data = ratchet.readBaseline(file);
    expect(data).not.toBeNull();
    for (const [rule, count] of Object.entries(data!.rules)) {
      expect(typeof rule).toBe('string');
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('grep estimate (provisional baseline)', () => {
  it('mirrors the no-console exemptions of eslint.config.js', () => {
    expect(ratchet.isConsoleAllowed('src/cli/service.ts')).toBe(true);
    expect(ratchet.isConsoleAllowed('src/index.ts')).toBe(true);
    expect(ratchet.isConsoleAllowed('src/core/agent.test.ts')).toBe(true);
    expect(ratchet.isConsoleAllowed('src/core/agent.ts')).toBe(false);
    expect(ratchet.isConsoleAllowed('src/ui/App.tsx')).toBe(false);
  });

  it('counts console calls outside the exempt paths and explicit any in type positions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-estimate-'));
    try {
      // estimateCounts resolves exemptions relative to the repo root, so the
      // fixture lives in a fake `src` whose relative path is never exempt.
      const src = join(dir, 'fixture');
      mkdirSync(join(src, 'core'), { recursive: true });
      writeFileSync(join(src, 'core', 'a.ts'), [
        'console.log("one");',
        'console.error("two");',
        'const x: any = 1;',
        'function f(y: any[]): Promise<any> { return y as any; }',
        'const company = "anything"; // not a type',
      ].join('\n'));
      const counts = ratchet.estimateCounts(src);
      expect(counts['no-console']).toBe(2);
      expect(counts['@typescript-eslint/no-explicit-any']).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
