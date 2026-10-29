import { afterEach, describe, expect, it } from 'vitest';
import { voiceFeed } from './voice-feed.js';

describe('voice feed', () => {
  afterEach(() => voiceFeed.reset());

  it('follows a session: start, question, activity, answer, end', () => {
    const events: string[] = [];
    const off = voiceFeed.subscribe((e) => events.push(e.type === 'turn' ? `turn:${e.turn?.role}` : 'state'));
    voiceFeed.attach('Optimus', () => {});
    voiceFeed.started('desk-1');
    voiceFeed.activity({ listening: true, working: false, muted: false, speaking: false });
    voiceFeed.asked('desk-1', 'what is on my calendar');
    expect(voiceFeed.snapshot().thinking).toBe(true);
    voiceFeed.doing('checking the calendar');
    voiceFeed.answered('Two meetings this afternoon.');
    const s = voiceFeed.snapshot();
    expect(s.active).toBe(true);
    expect(s.thinking).toBe(false);
    expect(s.turns.map((t) => t.role)).toEqual(['owner', 'activity', 'mercury']);
    voiceFeed.ended('desk-1', 'completed');
    expect(voiceFeed.snapshot().active).toBe(false);
    expect(voiceFeed.snapshot().turns).toHaveLength(3);
    expect(events).toContain('turn:owner');
    off();
  });

  it('controls reach the plugin only while a session is live', () => {
    const sent: string[] = [];
    voiceFeed.attach('Optimus', (a) => sent.push(a));
    expect(voiceFeed.control('mute')).toBe(false);
    voiceFeed.started('desk-2');
    expect(voiceFeed.control('mute')).toBe(true);
    expect(voiceFeed.control('stop')).toBe(true);
    expect(sent).toEqual(['mute', 'stop']);
    voiceFeed.detach('Optimus');
    expect(voiceFeed.control('mute')).toBe(false);
  });

  it('the control route accepts only known actions', async () => {
    const { default: routes } = await import('../web/api/voice.js');
    const bad = await routes.request('http://x/api/voice/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rm' }) });
    expect(bad.status).toBe(400);
    const idle = await routes.request('http://x/api/voice/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mute' }) });
    expect(idle.status).toBe(409);
  });
});
