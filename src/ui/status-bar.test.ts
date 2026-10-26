import { describe, expect, it } from 'vitest';
import { SEPARATOR, activityLine, budgetBar, fitSegments, phaseFromStep, shortModel, shortSession, splitRow, statusSegments } from './status-bar.js';

const row = (segs: Array<{ text: string }>) => segs.map((s) => s.text).join(SEPARATOR);

describe('status bar: model and session names', () => {
  it('says the model the way a person would', () => {
    expect(shortModel('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(shortModel('minimax-m3.1-flash:free')).toBe('minimax-m3.1-flash:free');
    expect(shortModel('minimax-m3.1-flash:free', { compact: true })).toBe('minimax-m3.1-flash');
    expect(shortModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(shortModel('a-very-long-vendor-model-name-with-many-parts-v2-preview')).toBe('a-very-long-vendor-model-na…');
  });

  it('keeps the session alias short', () => {
    expect(shortSession('quiet-harbour')).toBe('quiet-harbour');
    expect(shortSession('an unusually long session alias here')).toBe('an unusually lo…');
  });
});

describe('status bar: fitting the right half', () => {
  const inputs = {
    provider: { name: 'mercuryCloud', model: 'minimax-m3.1-flash:free' },
    permission: 'ask-me' as const,
    tokensPct: 12,
    codeMode: 'off',
    session: { alias: 'quiet-harbour', shortId: 'ab12' },
  };

  it('at full width shows everything: permission, the budget meter, the model, the session last', () => {
    const segs = fitSegments(statusSegments(inputs), 120);
    expect(row(segs)).toBe('Ask Me · ⚡ █░░░░░░░ 12% · minimax-m3.1-flash:free · quiet-harbour');
  });

  it('when narrow, compacts the least important first, then drops the session and the model; permission and budget stay', () => {
    expect(row(fitSegments(statusSegments(inputs), 60))).toBe('Ask Me · ⚡ █░░░░░░░ 12% · minimax-m3.1-flash · quiet-har…');
    expect(row(fitSegments(statusSegments(inputs), 44))).toBe('Ask · ⚡12% · minimax-m3.1-flash · quiet-har…');
    expect(row(fitSegments(statusSegments(inputs), 32))).toBe('Ask · ⚡12% · minimax-m3.1-flash');
    expect(row(fitSegments(statusSegments(inputs), 12))).toBe('Ask · ⚡12%');
    expect(row(fitSegments(statusSegments(inputs), 4))).toBe('Ask');
  });

  it('the budget meter fills with use: green, yellow from 70 %, red from 90 %', () => {
    expect(budgetBar(0)).toBe('░░░░░░░░');
    expect(budgetBar(50)).toBe('████░░░░');
    expect(budgetBar(100)).toBe('████████');
    expect(budgetBar(140)).toBe('████████');
    const seg = (pct: number) => statusSegments({ tokensPct: pct })[0];
    expect(seg(12)).toMatchObject({ text: '⚡ █░░░░░░░ 12%', compact: '⚡12%', color: 'green' });
    expect(seg(75)).toMatchObject({ text: '⚡ ██████░░ 75%', color: 'yellow' });
    expect(seg(95)).toMatchObject({ text: '⚡ ████████ 95%', color: 'red' });
    // Unknown budget: no meter rather than a wrong one.
    expect(statusSegments({ tokensPct: null })).toEqual([]);
  });

  it('Optimus activity outranks everything: when the row is overloaded it is the last thing kept', () => {
    const busy = { ...inputs, desktop: '🎙 Optimus listening' };
    expect(row(fitSegments(statusSegments(busy), 30))).toBe('🎙 Optimus listening · Ask');
    expect(row(fitSegments(statusSegments(busy), 20))).toBe('🎙 Optimus listening');
    expect(row(fitSegments(statusSegments({ ...busy, desktop: '🖥 Optimus working: opening Finder' }), 40))).toBe('🖥 Optimus working: opening Finder · Ask');
  });

  it('a long model never pushes tokens or permission off the row', () => {
    const segs = fitSegments(statusSegments({ ...inputs, provider: { name: 'aimlapi', model: 'anthropic/claude-sonnet-4.6-extended-thinking-preview-2026' } }), 40);
    const text = row(segs);
    expect(text).toContain('Ask');
    expect(text).toContain('⚡12%');
    expect(text.length).toBeLessThanOrEqual(40);
  });

  it('live things come first: Optimus, then Allow All in yellow, Code mode and an update', () => {
    const segs = fitSegments(statusSegments({ ...inputs, permission: 'allow-all', desktop: '🎙 Optimus listening', codeMode: 'auto', updateAvailable: 'v1.5.0' }), 200);
    expect(row(segs)).toBe('🎙 Optimus listening · Allow All · ⚡ █░░░░░░░ 12% · minimax-m3.1-flash:free · CODE AUTO · ⬆ v1.5.0 · quiet-harbour');
    expect(segs[1].color).toBe('yellow');
  });
});

describe('status bar: the left half', () => {
  it('shows the phase and elapsed time while busy, a notice above all, and nothing when idle', () => {
    expect(activityLine({ busy: true, phase: 'run_command', elapsedSec: 7, spinner: '⠙' })).toEqual({ text: '⠙ run_command · 7s', color: 'cyan', dim: false });
    expect(activityLine({ busy: true, elapsedSec: 95 }).text).toBe('⠋ Thinking · 1m 35s');
    expect(activityLine({ busy: true, elapsedSec: 95 }).color).toBe('red');
    expect(activityLine({ busy: true, notice: '⚠ send failed' }).text).toBe('⚠ send failed');
    // No key hints: Enter sends, /help lists commands, and the row is for status.
    expect(activityLine({ busy: false }).text).toBe('');
  });

  it('splits the row so the left never takes more than its share, and gives it all to the right when idle', () => {
    expect(splitRow(80, '⠙ Thinking · 4s')).toEqual({ left: 15, right: 64 });
    expect(splitRow(80, '')).toEqual({ left: 0, right: 79 });
    expect(splitRow(40, 'x'.repeat(60))).toEqual({ left: 22, right: 17 });
  });

  it('names the phase from the running step', () => {
    expect(phaseFromStep('read_file', false)).toBe('read_file');
    expect(phaseFromStep(null, true)).toBe('Writing');
    expect(phaseFromStep(null, false)).toBe('Thinking');
  });
});
