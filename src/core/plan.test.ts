import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizePlan, PlanStore } from './plan.js';

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
