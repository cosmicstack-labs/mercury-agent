import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRepository } from '../sessions/index.js';
import { voiceFeed } from './voice-feed.js';
import { callDuration, recordVoiceCalls } from './voice-calls.js';

let sessions: SessionRepository;
let stop: () => void;

beforeEach(() => {
  voiceFeed.reset();
  sessions = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-calls-')), autoMigrate: false });
  stop = recordVoiceCalls(sessions);
});
afterEach(() => stop());

describe('voice calls as chat threads', () => {
  it('writes what was said into a thread as it happens, and names it with the length at the end', () => {
    voiceFeed.started('desk-1');
    const threadId = voiceFeed.snapshot().threadId!;
    expect(threadId).toBeTruthy();
    voiceFeed.said('desk-1', 'owner', 'What is on my calendar today?');
    voiceFeed.asked('desk-1', 'Read the owner\'s calendar for today');
    voiceFeed.said('desk-1', 'mercury', 'You have two meetings.');
    voiceFeed.answered('Two meetings: 10:00 Design review, 15:00 Investor call.');

    const live = sessions.get(threadId);
    expect(live.messages.map((m) => [m.role, m.metadata?.voiceRole])).toEqual([
      ['user', 'owner'], ['assistant', 'mercury'], ['assistant', 'result'],
    ]);
    expect(live.messages[0].content).toBe('What is on my calendar today?');
    expect(live.title).toMatch(/^Voice call · /);

    voiceFeed.ended('desk-1', 'completed');
    expect(sessions.get(threadId).title).toMatch(/^Voice call · .+ · \d+s$/);
  });

  it('a call where nothing was said leaves no thread', () => {
    voiceFeed.started('desk-2');
    const threadId = voiceFeed.snapshot().threadId!;
    voiceFeed.ended('desk-2', 'failed: no microphone');
    expect(sessions.list().some((s) => s.id === threadId)).toBe(false);
  });

  it('without a live transcript (older Optimus), the question and answer are what gets saved', () => {
    voiceFeed.started('desk-3');
    const threadId = voiceFeed.snapshot().threadId!;
    voiceFeed.asked('desk-3', 'Open Gmail');
    voiceFeed.answered('Opened Gmail.');
    expect(sessions.get(threadId).messages.map((m) => [m.role, m.content])).toEqual([['user', 'Open Gmail'], ['assistant', 'Opened Gmail.']]);
  });
});

describe('voice feed controls and levels', () => {
  it('start only works with the plugin attached and no session running', () => {
    const sent = vi.fn();
    expect(voiceFeed.control('start')).toBe(false);
    voiceFeed.attach('Optimus', sent);
    expect(voiceFeed.control('start')).toBe(true);
    expect(sent).toHaveBeenCalledWith('start');
    expect(voiceFeed.control('mute')).toBe(false);
    voiceFeed.started('desk-4');
    expect(voiceFeed.control('start')).toBe(false);
    expect(voiceFeed.control('mute')).toBe(true);
  });

  it('streams levels while a session runs, clamped, and never stores them', () => {
    const seen: unknown[] = [];
    const off = voiceFeed.subscribe((e) => { if (e.type === 'level') seen.push(e.levels); });
    voiceFeed.levels(0.5, 0.2);
    expect(seen).toHaveLength(0);
    voiceFeed.started('desk-5');
    voiceFeed.levels(1.7, Number.NaN);
    off();
    expect(seen).toEqual([expect.objectContaining({ mic: 1, out: 0 })]);
    expect(JSON.stringify(voiceFeed.snapshot())).not.toContain('mic');
  });

  it('formats call lengths', () => {
    expect(callDuration(42)).toBe('42s');
    expect(callDuration(185)).toBe('3 min');
    expect(callDuration(3720)).toBe('1h 2m');
  });
});
