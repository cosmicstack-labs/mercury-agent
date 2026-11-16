import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
const { spawnSync } = await import('node:child_process');
const { acknowledgeSecret } = await import('./clipboard.js');

describe('acknowledgeSecret', () => {
  it('shows the whole token, copies it on request, then waits for done', async () => {
    const titles: string[] = [];
    const answers = ['copy', 'ok'];
    await acknowledgeSecret(async (t) => { titles.push(t); return answers.shift(); }, 'Token: mdt_x', 'mdt_x');
    expect(titles[0]).toBe('Token: mdt_x');
    expect(titles[1]).toContain('Copied to the clipboard');
    expect(vi.mocked(spawnSync).mock.calls[0][2]).toMatchObject({ input: 'mdt_x' });
  });

  it('without a value to copy, offers only the acknowledgement', async () => {
    const seen: string[][] = [];
    await acknowledgeSecret(async (_t, o) => { seen.push(o.map((x) => x.value)); return 'ok'; }, 'hello');
    expect(seen).toEqual([['ok']]);
  });
});
