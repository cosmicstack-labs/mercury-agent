import { describe, expect, it } from 'vitest';
import { AlertGate } from './alert-gate.js';

describe('AlertGate (broadcasts never loop or repeat)', () => {
  it('drops a broadcast started from inside another (a channel forwarding back to all channels)', async () => {
    const gate = new AlertGate();
    const sent: string[] = [];
    const broadcast = (m: string): Promise<string> => gate.run(m, async () => {
      sent.push(m);
      // The desktop channel forwards to "notify the owner", which broadcasts again.
      await broadcast(`${m} (forwarded)`);
    });
    expect(await broadcast('Mercury is shutting down')).toBe('sent');
    expect(sent).toEqual(['Mercury is shutting down']);
  });

  it('sends the same alert once per window', async () => {
    let t = 0;
    const gate = new AlertGate(60_000, () => t);
    const send = async () => {};
    expect(await gate.run('Optimus can\'t listen yet', send)).toBe('sent');
    t = 30_000;
    expect(await gate.run('Optimus can\'t listen yet', send)).toBe('repeat');
    expect(await gate.run('something else', send)).toBe('sent');
    t = 61_000;
    expect(await gate.run('Optimus can\'t listen yet', send)).toBe('sent');
  });

  it('a failed send still releases the gate', async () => {
    const gate = new AlertGate();
    await expect(gate.run('a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await gate.run('b', async () => {})).toBe('sent');
  });
});
