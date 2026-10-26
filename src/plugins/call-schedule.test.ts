import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallScheduler, handleCallCommand, parseWhen, registerCallScheduler } from './call-schedule.js';
import { publishTool, resetToolBridge } from './tool-bridge.js';
import { tempHome } from './test-fixtures.js';

// Tue 21 Oct 2026, 14:00 local time.
const NOW = new Date(2026, 9, 21, 14, 0, 0);
const hm = (d: Date | null) => d && `${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('parseWhen', () => {
  it.each([
    ['9pm', '21 21:00'],
    ['after 9 PM', '21 21:00'],
    ['at 9', '21 21:00'], // a bare 9 at 14:00 means 9 tonight
    ['9', '21 21:00'],
    ['1pm', '22 13:00'], // already past today → tomorrow
    ['21:30', '21 21:30'],
    ['9:15 am', '22 09:15'],
    ['tonight at 8', '21 20:00'],
    ['tomorrow 8:30am', '22 08:30'],
    ['tomorrow 8', '22 08:00'],
    ['tomorrow at 3', '22 15:00'],
    ['in 20 minutes', '21 14:20'],
    ['20m', '21 14:20'],
    ['in 2 hours', '21 16:00'],
    ['in an hour', '21 15:00'],
    ['in half an hour', '21 14:30'],
  ])('%s → %s', (input, want) => {
    expect(hm(parseWhen(input, NOW))).toBe(want);
  });

  it('rejects what it can\'t understand', () => {
    for (const bad of ['whenever', '25:00', '13pm', 'next week sometime', '']) expect(parseWhen(bad, NOW)).toBeNull();
  });
});

describe('CallScheduler', () => {
  let env: ReturnType<typeof tempHome>;
  beforeEach(() => { env = tempHome(); resetToolBridge(); });
  afterEach(() => { registerCallScheduler('whatsapp', null); resetToolBridge(); vi.useRealTimers(); env.restore(); });

  it('confirms with the exact time, lists, cancels, and survives a restart', () => {
    const notes: string[] = [];
    const s = new CallScheduler('whatsapp', async (t) => { notes.push(t); });
    s.start();
    expect(s.schedule('9pm', 'the deploy', NOW).confirmation).toMatch(/^✅ I'll call you at 9:00\s?PM.* tonight \(in 7 h\) about the deploy\.$/i);
    s.cancel('all');
    s.schedule('in 3 hours', 'the deploy');
    s.schedule('tomorrow 8am', 'standup');
    expect(s.list().map((c) => c.topic).sort()).toEqual(['standup', 'the deploy']);
    s.stop();

    const again = new CallScheduler('whatsapp', async (t) => { notes.push(t); });
    again.start(); // reloaded from disk
    expect(again.list()).toHaveLength(2);
    const first = again.list()[0].topic;
    expect(again.cancel('1')).toBe(1);
    expect(again.list().map((c) => c.topic)).toEqual([first === 'standup' ? 'the deploy' : 'standup']);
    expect(again.cancel('all')).toBe(1);
    again.stop();
  });

  it('rings the owner at the time; no answer → one retry, then a message', async () => {
    vi.useFakeTimers({ now: NOW });
    const rings: string[] = [];
    let answer = 'no_answer: the owner did not pick up.';
    publishTool({
      pluginId: 'whatsapp', pluginName: 'WhatsApp', name: 'call_owner', description: '', inputSchema: {}, readOnly: false, timeoutMs: 1000,
      invoke: async (args) => { rings.push(String((args as { reason: string }).reason)); return answer; },
    });
    const notes: string[] = [];
    const s = new CallScheduler('whatsapp', async (t) => { notes.push(t); });
    registerCallScheduler('whatsapp', s);
    s.start();
    s.schedule('in 10 minutes', 'the deploy', new Date());
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 50);
    expect(rings).toEqual(['you asked me to call about the deploy']);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 50);
    expect(rings).toHaveLength(2);
    expect(notes[0]).toMatch(/tried to call you about the deploy, but you didn't pick up/);
    expect(s.list()).toEqual([]);

    // Answered first time: no retry, no message.
    answer = 'answered: the owner picked up.';
    s.schedule('in 1 minute', 'lunch', new Date());
    await vi.advanceTimersByTimeAsync(60_000 + 50);
    expect(rings).toHaveLength(3);
    expect(notes).toHaveLength(1);
    s.stop();
  });

  it('/call and /calls work without any model', () => {
    const s = new CallScheduler('whatsapp', async () => {});
    registerCallScheduler('whatsapp', s);
    s.start();
    expect(handleCallCommand('/call 9pm about the deploy', false)).toMatch(/I'll call you at .*about the deploy/);
    expect(handleCallCommand('/call in 20 minutes', false)).toMatch(/I'll call you at/);
    expect(handleCallCommand('/calls', false)).toMatch(/Scheduled calls:\n1\. [\s\S]*\n2\. /);
    expect(handleCallCommand('/call whenever', false)).toMatch(/couldn't work out when "whenever"/);
    expect(handleCallCommand('/calls cancel all', false)).toBe('🗑 Cancelled 2 calls.');
    expect(handleCallCommand('/call 9pm', true)).toBe('Only the owner can schedule calls.');
    registerCallScheduler('whatsapp', null);
    expect(handleCallCommand('/call 9pm', false)).toMatch(/need the WhatsApp plugin/);
    s.stop();
  });
});
