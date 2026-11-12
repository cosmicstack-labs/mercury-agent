import { describe, expect, it } from 'vitest';
import { WebChannel } from './web.js';

/**
 * Tool events reach the desktop as each tool starts and ends (not both
 * after the step), carrying the call id that pairs them and the runtime's
 * own duration. Notes mid-turn are progress events, never a finished reply.
 */
function capture(ch: WebChannel): Array<{ type: string; data?: Record<string, unknown> }> {
  const sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  (ch as unknown as { broadcast: (e: { type: string; data?: Record<string, unknown> }) => boolean }).broadcast = (e) => { sent.push(e); return true; };
  return sent;
}

describe('web channel live tool events', () => {
  it('start and finish carry the call id, a readable title and the duration', () => {
    const ch = new WebChannel('Mercury');
    const sent = capture(ch);
    ch.sendToolStarted('call_1', 'read_file', { path: 'src/a.ts' }, 's1');
    ch.sendToolFinished('call_1', 'read_file', 'line 1\nline 2', false, 41.6, 's1');
    expect(sent[0]).toMatchObject({ type: 'step_start', data: { id: 'call_1', step: 1, tool: 'read_file', targetId: 's1' } });
    expect(sent[0].data?.title).toBe('Reading a.ts');
    expect(String(sent[0].data?.title)).not.toMatch(/^[^\p{L}\p{N}]/u);
    expect(sent[1]).toEqual({ type: 'step_done', data: { id: 'call_1', tool: 'read_file', summary: 'line 1\nline 2', failed: false, durationMs: 42, targetId: 's1' } });
  });

  it('a thrown tool error is a failure with a reason', () => {
    const ch = new WebChannel('Mercury');
    const sent = capture(ch);
    ch.sendToolFinished('c', 'run_command', new Error('spawn ENOENT'), true, 5, 's1');
    expect(sent[0].data).toMatchObject({ failed: true });
    expect(String(sent[0].data?.reason)).toBeTruthy();
  });

  it('progress notes and phases are their own events', () => {
    const ch = new WebChannel('Mercury');
    const sent = capture(ch);
    ch.sendProgressNote('Checking my work…', 's1');
    ch.sendPhase('Calling anthropic', 'claude-opus-5-5', 's1');
    ch.sendProviderInfo('anthropic', 'claude-opus-5-5', 's1');
    expect(sent.map((e) => e.type)).toEqual(['progress', 'phase', 'provider']);
    expect(sent.some((e) => e.type === 'text_done')).toBe(false);
    expect(sent[2].data).toMatchObject({ name: 'anthropic', provider: 'anthropic' });
  });

  it('a media tool says what it is making, so a screen can hold its place', () => {
    const ch = new WebChannel('Mercury');
    const sent = capture(ch);
    ch.sendToolStarted('c', 'generate_image', { prompt: 'a fox', aspect: 'landscape', count: 9 }, 's1');
    ch.sendToolStarted('d', 'read_file', { path: 'x' }, 's1');
    expect(sent[0].data?.media).toEqual({ kind: 'image', aspect: 'landscape', count: 4, prompt: 'a fox' });
    expect(sent[1].data).not.toHaveProperty('media');
    ch.sendMediaPending({ id: 'j1', kind: 'video', prompt: 'surf', createdAt: 5, aspect: 'portrait' }, 's1');
    ch.sendMediaReady('ready', [], 's1', 'j1');
    expect(sent[2]).toEqual({ type: 'media_pending', data: { jobId: 'j1', kind: 'video', prompt: 'surf', startedAt: 5, aspect: 'portrait', targetId: 's1' } });
    expect(sent[3].data).toMatchObject({ jobId: 'j1' });
  });
});
