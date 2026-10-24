import { describe, expect, it } from 'vitest';
import { SEPARATOR, activityLine, fitSegments, phaseFromStep, shortModel, shortSession, splitRow, statusSegments } from './status-bar.js';

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

  it('at full width shows everything, permission first and the session last', () => {
    const segs = fitSegments(statusSegments(inputs), 120);
    expect(row(segs)).toBe('Ask Me · mercuryCloud · minimax-m3.1-flash:free · ⚡ 12% today · quiet-harbour');
  });

  it('when narrow, compacts the least important first, then drops the session, never the permission mode', () => {
    const at60 = row(fitSegments(statusSegments(inputs), 44));
    expect(at60).toBe('Ask · minimax-m3.1-flash · ⚡12% · quiet-har…');
    const at32 = row(fitSegments(statusSegments(inputs), 32));
    expect(at32).toBe('Ask · minimax-m3.1-flash · ⚡12%');
    expect(row(fitSegments(statusSegments(inputs), 30))).toBe('Ask · minimax-m3.1-flash');
    const at12 = row(fitSegments(statusSegments(inputs), 12));
    expect(at12).toBe('Ask · ⚡12%');
    expect(row(fitSegments(statusSegments(inputs), 4))).toBe('Ask');
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
    expect(row(segs)).toBe('🎙 Optimus listening · Allow All · mercuryCloud · minimax-m3.1-flash:free · ⚡ 12% today · CODE AUTO · ⬆ v1.5.0 · quiet-harbour');
    expect(segs[1].color).toBe('yellow');
  });

  it('token colour follows the budget', () => {
    expect(statusSegments({ tokensPct: 95 })[0].color).toBe('red');
    expect(statusSegments({ tokensPct: 75 })[0].color).toBe('yellow');
    expect(statusSegments({ tokensPct: 10 })[0].color).toBe('cyan');
  });
});

describe('status bar: the left half', () => {
  it('shows the phase and elapsed time while busy, a notice above all, and hints when idle', () => {
    expect(activityLine({ busy: true, phase: 'run_command', elapsedSec: 7, spinner: '⠙' })).toEqual({ text: '⠙ run_command · 7s', color: 'cyan', dim: false });
    expect(activityLine({ busy: true, elapsedSec: 95 }).text).toBe('⠋ Thinking · 1m 35s');
    expect(activityLine({ busy: true, elapsedSec: 95 }).color).toBe('red');
    expect(activityLine({ busy: true, notice: '⚠ send failed' }).text).toBe('⚠ send failed');
    expect(activityLine({ busy: false, hints: '↵ send · /help' })).toEqual({ text: '↵ send · /help', color: 'gray', dim: true });
  });

  it('splits the row so the left never takes more than its share', () => {
    expect(splitRow(80, '↵ send · /help')).toEqual({ left: 14, right: 65 });
    expect(splitRow(40, 'x'.repeat(60))).toEqual({ left: 22, right: 17 });
  });

  it('names the phase from the running step', () => {
    expect(phaseFromStep('read_file', false)).toBe('read_file');
    expect(phaseFromStep(null, true)).toBe('Writing');
    expect(phaseFromStep(null, false)).toBe('Thinking');
  });
});
