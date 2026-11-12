import { describe, expect, it } from 'vitest';
import { TurnTrace, toolSummary } from './turn-trace.js';

describe('TurnTrace', () => {
  it('keeps thinking and tools in order, with durations', () => {
    let now = 1000;
    const t = new TurnTrace(() => now);
    t.reasoning('Plan ');
    t.reasoning('it.');
    now = 1500;
    t.toolStarted('c1', '📖 Read src/x.ts');
    now = 1800;
    t.toolFinished('c1', false, 250, 'ok');
    t.reasoning('Next.');
    t.reasoningEnded();
    t.toolStarted('c2', 'Run npm test');
    now = 4000;
    const snap = t.snapshot(900)!;
    expect(snap.startedAt).toBe(900);
    expect(snap.items.map((i) => i.kind)).toEqual(['reasoning', 'tool', 'reasoning', 'tool']);
    expect(snap.items[0]).toMatchObject({ text: 'Plan it.', startedAt: 1000, endedAt: 1500 });
    expect(snap.items[1]).toMatchObject({ id: 'c1', title: 'Read src/x.ts', status: 'done', durationMs: 250, summary: 'ok' });
    // Still running when the turn ended: cut off.
    expect(snap.items[3]).toMatchObject({ id: 'c2', status: 'error', summary: 'Stopped' });
  });

  it('is empty when the turn neither thought nor ran anything', () => {
    expect(new TurnTrace().snapshot(0)).toBeUndefined();
  });

  it('caps a very long turn', () => {
    const t = new TurnTrace();
    for (let i = 0; i < 400; i++) { t.toolStarted(`c${i}`, 'x'); t.toolFinished(`c${i}`, false, 1, undefined); }
    t.reasoning('y'.repeat(100_000));
    const snap = t.snapshot(0)!;
    expect(snap.items.length).toBeLessThanOrEqual(150);
    const text = snap.items.filter((i) => i.kind === 'reasoning').map((i) => (i as { text: string }).text).join('');
    expect(text.length).toBeLessThanOrEqual(24_000);
  });

  it('summarises a result to its first line', () => {
    expect(toolSummary('\n first line \nsecond')).toBe('first line');
    expect(toolSummary({ ok: true })).toBe('{"ok":true}');
    expect(toolSummary(new Error('boom'))).toBe('boom');
    expect(toolSummary(undefined)).toBeUndefined();
  });
});
