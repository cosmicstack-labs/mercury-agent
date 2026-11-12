import { describe, expect, it } from 'vitest';
import { ScopedValue, inTurnScope, runInTurnScope } from './turn-scope.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe('ScopedValue', () => {
  it('reads and writes the process-wide value outside a turn', () => {
    const v = new ScopedValue('a');
    expect(inTurnScope()).toBe(false);
    v.set('b');
    expect(v.get()).toBe('b');
    expect(v.claim()).toBe(false);
  });

  it('an unclaimed value inside a turn is still the process-wide one', async () => {
    const v = new ScopedValue('a');
    await runInTurnScope(async () => {
      v.set('b');
    });
    expect(v.get()).toBe('b');
  });

  it('a claimed value is private to its turn, across awaits and timers', async () => {
    const v = new ScopedValue('/home');
    const seen: string[] = [];
    const turn = (dir: string, delay: number) => runInTurnScope(async () => {
      v.claim();
      v.set(dir);
      await new Promise<void>((r) => setTimeout(r, delay));
      await tick();
      seen.push(`${dir}:${v.get()}`);
    });
    await Promise.all([turn('/one', 5), turn('/two', 1)]);
    expect(seen.sort()).toEqual(['/one:/one', '/two:/two']);
    expect(v.get()).toBe('/home');
  });

  it('claim starts from the process-wide value unless given one', async () => {
    const v = new ScopedValue(1);
    await runInTurnScope(async () => {
      v.claim();
      expect(v.get()).toBe(1);
      v.claim(7);
      expect(v.get()).toBe(7);
      expect(v.getGlobal()).toBe(1);
    });
  });

  it('two values never share a turn copy', async () => {
    const a = new ScopedValue('a');
    const b = new ScopedValue('b');
    await runInTurnScope(async () => {
      a.claim('A');
      expect(b.isClaimed()).toBe(false);
      b.set('B');
    });
    expect(a.get()).toBe('a');
    expect(b.get()).toBe('B');
  });
});
