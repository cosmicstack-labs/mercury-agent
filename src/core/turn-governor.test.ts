import { describe, expect, it, vi } from 'vitest';
import { autoTurnLimit, resolveTurnLimit, TurnGovernor, TURN_HEAP_BUDGET_BYTES, type GovernedTurn } from './turn-governor.js';
import { taskHeapAbortThreshold } from './memory-guard.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function turn(id: string, startedAt: number, stopping = false): GovernedTurn & { shed: ReturnType<typeof vi.fn> } {
  return { id, startedAt, label: id, isStopping: () => stopping, shed: vi.fn() };
}

function governor(heap: { used: number }, opts: Partial<{ limit: number; available: number | null; now: () => number; onExit: (n: number) => void }> = {}) {
  return new TurnGovernor({
    limit: opts.limit ?? 4,
    heapSizeLimit: 4 * GB,
    heapUsed: () => heap.used,
    systemAvailable: () => (opts.available === undefined ? null : opts.available),
    totalMem: 16 * GB,
    now: opts.now,
    onExit: opts.onExit,
  });
}

describe('turn limit', () => {
  it('is capped at 2 on Termux and small machines, 3 under 8 GB, 4 otherwise', () => {
    expect(autoTurnLimit({ heapSizeLimit: 4 * GB, totalMem: 16 * GB, termux: false })).toBe(4);
    expect(autoTurnLimit({ heapSizeLimit: 4 * GB, totalMem: 6 * GB, termux: false })).toBe(3);
    expect(autoTurnLimit({ heapSizeLimit: 4 * GB, totalMem: 3 * GB, termux: false })).toBe(2);
    expect(autoTurnLimit({ heapSizeLimit: 4 * GB, totalMem: 16 * GB, termux: true })).toBe(2);
  });

  it('follows heap headroom and never drops below 1', () => {
    expect(autoTurnLimit({ heapSizeLimit: 512 * MB + 2 * TURN_HEAP_BUDGET_BYTES, totalMem: 16 * GB, termux: false })).toBe(2);
    expect(autoTurnLimit({ heapSizeLimit: 256 * MB, totalMem: 16 * GB, termux: false })).toBe(1);
  });

  it('a configured limit wins and is clamped to 1..16', () => {
    const m = { heapSizeLimit: 4 * GB, totalMem: 16 * GB, termux: true };
    expect(resolveTurnLimit(8, m)).toBe(8);
    expect(resolveTurnLimit(99, m)).toBe(16);
    expect(resolveTurnLimit(0, m)).toBe(2);
    expect(resolveTurnLimit(undefined, m)).toBe(2);
    expect(resolveTurnLimit(Number.NaN, m)).toBe(2);
  });
});

describe('TurnGovernor admission', () => {
  it('always admits the first turn, even under pressure', () => {
    const heap = { used: 3.9 * GB };
    expect(governor(heap).canAdmit(0)).toEqual({ ok: true });
  });

  it('stops at the limit', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap, { limit: 2 });
    expect(g.canAdmit(1)).toEqual({ ok: true });
    expect(g.canAdmit(2)).toEqual({ ok: false, reason: 'capacity' });
  });

  it('refuses when the heap leaves no budget for another turn', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap);
    const line = g.stopLine(2);
    heap.used = line - TURN_HEAP_BUDGET_BYTES + 1;
    expect(g.canAdmit(1)).toEqual({ ok: false, reason: 'memory' });
    heap.used = line - TURN_HEAP_BUDGET_BYTES - 1;
    expect(g.canAdmit(1)).toEqual({ ok: true });
  });

  it('refuses when the system is nearly out of memory (where that is measurable)', () => {
    const heap = { used: 100 * MB };
    expect(governor(heap, { available: 50 * MB }).canAdmit(1)).toEqual({ ok: false, reason: 'system-memory' });
    expect(governor(heap, { available: 4 * GB }).canAdmit(1)).toEqual({ ok: true });
    expect(governor(heap, { available: null }).canAdmit(1)).toEqual({ ok: true });
  });
});

describe('TurnGovernor lines', () => {
  it('with one turn, the stop line is the old per-task guard line', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap);
    expect(g.stopLine(1)).toBe(taskHeapAbortThreshold(4 * GB, 100 * MB));
    expect(g.exitLine(1)).toBe(g.stopLine(1) + 256 * MB);
  });

  it('widens by one turn budget per extra turn, capped by the abort line', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap);
    expect(g.stopLine(3) - g.stopLine(1)).toBe(2 * TURN_HEAP_BUDGET_BYTES);
    expect(g.stopLine(1000)).toBe(g.getThresholds().abortBytes);
  });
});

describe('TurnGovernor pressure', () => {
  it('sheds the newest turn that is not already stopping, once per cooldown', () => {
    let now = 1_000_000;
    const heap = { used: 100 * MB };
    const g = governor(heap, { now: () => now });
    const old = turn('old', 1);
    const mid = turn('mid', 2);
    const stopping = turn('new', 3, true);
    heap.used = g.stopLine(3) + MB;
    expect(g.check([old, mid, stopping])).toEqual({ verdict: 'shed', shed: 'mid' });
    expect(mid.shed).toHaveBeenCalledOnce();
    expect(old.shed).not.toHaveBeenCalled();
    // Cooldown: nothing more for 5 s.
    expect(g.check([old, mid, stopping]).shed).toBeUndefined();
    now += 5_001;
    expect(g.check([old, turn('mid2', 2, true), stopping]).shed).toBe('old');
  });

  it('does nothing below the line', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap);
    const t = turn('a', 1);
    expect(g.check([t])).toEqual({ verdict: 'ok' });
    expect(t.shed).not.toHaveBeenCalled();
  });

  it('calls onExit once past the exit line', () => {
    const onExit = vi.fn();
    const heap = { used: 100 * MB };
    const g = governor(heap, { onExit });
    heap.used = g.exitLine(1) + MB;
    g.check([turn('a', 1)]);
    g.check([turn('a', 1)]);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('shouldShed is true only past the line and only for the pick', () => {
    const heap = { used: 100 * MB };
    const g = governor(heap);
    const a = turn('a', 1);
    const b = turn('b', 2);
    expect(g.shouldShed('b', [a, b])).toBe(false);
    heap.used = g.stopLine(2) + MB;
    expect(g.shouldShed('b', [a, b])).toBe(true);
    expect(g.shouldShed('a', [a, b])).toBe(false);
  });

  it('noteIdle lowers the baseline freely but raises it only a little', () => {
    const heap = { used: 300 * MB };
    const g = governor(heap);
    const before = g.stopLine(1);
    heap.used = 900 * MB;
    g.noteIdle();
    expect(g.stopLine(1) - before).toBeLessThanOrEqual(64 * MB);
    heap.used = 50 * MB;
    g.noteIdle();
    expect(g.stopLine(1)).toBe(taskHeapAbortThreshold(4 * GB, 50 * MB));
  });
});
