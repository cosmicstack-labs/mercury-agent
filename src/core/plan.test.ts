import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizePlan, PlanStore, settlePlan, type PlanStep } from './plan.js';

describe('plan checklist', () => {
  it('cleans what the model sends: unknown statuses and duplicates dropped, one active step', () => {
    expect(normalizePlan([
      { label: ' Research sources ', status: 'done' },
      { label: 'Compare', status: 'active' },
      { label: 'Compare', status: 'pending' },
      { label: 'Write up', status: 'active' },
      { label: 'Huh', status: 'maybe' },
      { label: '', status: 'pending' },
    ])).toEqual([
      { label: 'Research sources', status: 'done' },
      { label: 'Compare', status: 'active' },
      { label: 'Write up', status: 'pending' },
    ]);
    expect(normalizePlan('nope')).toEqual([]);
  });

  it('keeps the latest plan per conversation across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mercury-plans-')), 'plans.json');
    const a = new PlanStore(file);
    a.set('thread-1', [{ label: 'One', status: 'active' }], 5);
    a.set('thread-1', [{ label: 'One', status: 'done' }], 6);
    const b = new PlanStore(file);
    expect(b.get('thread-1')).toEqual({ steps: [{ label: 'One', status: 'done' }], updatedAt: 6 });
    expect(b.get('other')).toBeNull();
  });
});

const plan = (marks: string): PlanStep[] => [...marks].map((m, i) => ({ label: `step ${i + 1}`, status: m === '✓' ? 'done' : m === '◐' ? 'active' : 'pending' }));
const marks = (steps: PlanStep[]) => steps.map((s) => (s.status === 'done' ? '✓' : s.status === 'active' ? '◐' : '○')).join('');

describe('the plan a turn leaves behind', () => {
  it('the work is done and only the last tick was forgotten: done', () => {
    expect(marks(settlePlan(plan('✓✓✓✓◐'), 'completed')!.steps)).toBe('✓✓✓✓✓');
    expect(settlePlan(plan('✓✓✓✓◐'), 'completed')!.state).toBeUndefined();
    expect(marks(settlePlan(plan('✓✓✓○'), 'completed')!.steps)).toBe('✓✓✓✓');
  });

  it('a reply with several steps open: paused at the first open one', () => {
    const r = settlePlan(plan('✓◐○○○'), 'completed')!;
    expect(r.state).toBe('paused');
    expect(marks(r.steps)).toBe('✓◐○○○');
    expect(marks(settlePlan(plan('◐○○'), 'completed')!.steps)).toBe('◐○○');
  });

  it('stopped or failed: stopped, never a guessed tick', () => {
    expect(settlePlan(plan('✓✓✓◐'), 'stopped')).toMatchObject({ state: 'stopped' });
    expect(marks(settlePlan(plan('✓✓✓◐'), 'stopped')!.steps)).toBe('✓✓✓◐');
    expect(settlePlan(plan('✓○◐'), 'failed')).toMatchObject({ state: 'stopped' });
    expect(marks(settlePlan(plan('✓○◐'), 'failed')!.steps)).toBe('✓◐○');
  });

  it('nothing to do for a finished plan or none', () => {
    expect(settlePlan(plan('✓✓✓'), 'completed')).toBeNull();
    expect(settlePlan([], 'stopped')).toBeNull();
  });
});
