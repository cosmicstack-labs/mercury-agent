import { describe, expect, it } from 'vitest';
import { ProgrammingMode, scopedProgrammingState } from './programming-mode.js';

/**
 * Session-scoped coding: a Code session's mode is swapped in for its turn
 * and the global mode restored after, so Chat and the terminal never see it.
 */
describe('programming mode snapshots', () => {
  it('only accepts on-states for a scoped turn', () => {
    expect(scopedProgrammingState('auto')).toBe('auto');
    expect(scopedProgrammingState('plan')).toBe('plan');
    expect(scopedProgrammingState('execute')).toBe('execute');
    expect(scopedProgrammingState('off')).toBeNull();
    expect(scopedProgrammingState('rm -rf')).toBeNull();
    expect(scopedProgrammingState(undefined)).toBeNull();
  });

  it('swaps a session in and restores the global mode untouched', () => {
    const pm = new ProgrammingMode();
    expect(pm.getState()).toBe('off');
    const global = pm.snapshot();

    pm.restore({ state: 'plan', projectContext: '/work/app', lastPlan: null });
    pm.storePlan('1. do the thing');
    const session = pm.snapshot();
    pm.restore(global);

    expect(pm.getState()).toBe('off');
    expect(pm.getLastPlan()).toBeNull();
    expect(session).toEqual({ state: 'plan', projectContext: '/work/app', lastPlan: '1. do the thing' });

    // The session's plan is still there next turn.
    pm.restore({ ...session, state: 'execute' });
    expect(pm.isExecute()).toBe(true);
    expect(pm.getLastPlan()).toBe('1. do the thing');
  });
});
