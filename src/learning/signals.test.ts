import { describe, expect, it } from 'vitest';
import {
  collectTurnSignals, describeSignals, detectAutonomyRequest, detectBrevityRequest, detectCorrection,
  detectDecisionStyle, hasBehavioralSignal, normalizeMessage, parseToolTraceLines, timeOfDayBucket,
} from './signals.js';

describe('turn signals', () => {
  it('detects explicit corrections', () => {
    expect(detectCorrection('No, I meant the other file').cues).toContain('no, I meant');
    expect(detectCorrection("That's not what I asked for").cues).toContain("that's not what I asked");
    expect(detectCorrection('I said the config, not the README').cues).toContain('I said');
    expect(detectCorrection('Not that one. The second script.').detected).toBe(true);
    expect(detectCorrection('Do it again but shorter').cues).toContain('again');
    expect(detectCorrection('Thanks again!').detected).toBe(false);
    expect(detectCorrection('Can you list the files in src?').detected).toBe(false);
  });

  it('detects a repeated request within the session', () => {
    const r = detectCorrection('Run the tests please.', ['hi', 'run the tests, please']);
    expect(r.repeatedRequest).toBe(true);
    expect(r.detected).toBe(true);
    expect(detectCorrection('ok', ['ok']).repeatedRequest).toBe(false);
    expect(normalizeMessage('  Run   the TESTS, please!! ')).toBe('run the tests please');
  });

  it('detects brevity, autonomy and decision-style requests', () => {
    expect(detectBrevityRequest('tl;dr please')).toBe('shorter');
    expect(detectBrevityRequest('Can you give me more detail on step 2?')).toBe('longer');
    expect(detectBrevityRequest('List the files')).toBeNull();
    expect(detectAutonomyRequest("just do it, don't ask")).toBe('just-do-it');
    expect(detectAutonomyRequest('why did you ask? you can run tests here')).toBe('just-do-it');
    expect(detectAutonomyRequest('ask me first before deleting anything')).toBe('ask-first');
    expect(detectAutonomyRequest("don't ask about reads but ask first before publishing")).toBe('ask-first');
    expect(detectDecisionStyle('give me a few options')).toBe('options');
    expect(detectDecisionStyle('just pick one')).toBe('decide-for-me');
    expect(detectDecisionStyle('what do you recommend?')).toBe('recommendation');
    expect(detectDecisionStyle('fix the bug')).toBeNull();
  });

  it('buckets the local hour', () => {
    const at = (h: number) => { const d = new Date(2026, 9, 24, h, 5); return timeOfDayBucket(d); };
    expect(at(7)).toBe('morning');
    expect(at(14)).toBe('daytime');
    expect(at(20)).toBe('evening');
    expect(at(23)).toBe('late-night');
    expect(at(2)).toBe('late-night');
  });

  it('parses tool trace lines into names and failures', () => {
    const parsed = parseToolTraceLines([
      '- read_file src/a.ts → ok (40 lines)',
      '- run_command npm test → ✗ Command exited with code 1',
      'not a trace line',
    ]);
    expect(parsed).toEqual([{ tool: 'read_file', failed: false }, { tool: 'run_command', failed: true }]);
  });

  it('collects a full signal object and describes it', () => {
    const s = collectTurnSignals({
      message: "just do it, don't ask",
      previousUserMessages: ['hello'],
      toolTrace: [{ tool: 'run_command', failed: true }, { tool: 'run_command', failed: false }, { tool: 'read_file', failed: false }],
      channelType: 'cli',
      sessionId: 's1',
      cwd: '/tmp/proj',
      allowAllActive: true,
      permissionAnswers: [{ action: 'run_command', answer: 'always' }],
      now: new Date(2026, 9, 24, 9, 0),
    });
    expect(s.autonomy).toBe('just-do-it');
    expect(s.correction.detected).toBe(false);
    expect(s.tools).toEqual({ used: ['run_command', 'read_file'], failed: ['run_command'] });
    expect(s.timeOfDay).toBe('morning');
    expect(s.messageLength).toBe("just do it, don't ask".length);
    expect(hasBehavioralSignal(s)).toBe(true);
    const text = describeSignals(s);
    expect(text).toContain('autonomy request: just-do-it');
    expect(text).toContain('permission answers: run_command=always');
    expect(text).toContain('tools used: run_command, read_file; failed: run_command');
    expect(text).toContain('project cwd: /tmp/proj');
  });

  it('is quiet for an ordinary message', () => {
    const s = collectTurnSignals({ message: 'What time is it in Tokyo?', now: new Date(2026, 9, 24, 15, 0) });
    expect(hasBehavioralSignal(s)).toBe(false);
    expect(describeSignals(s)).toContain('correction: none detected');
  });
});
