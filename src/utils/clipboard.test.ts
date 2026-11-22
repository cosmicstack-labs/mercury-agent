import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
const { spawnSync } = await import('node:child_process');
const { acknowledgeSecret } = await import('./clipboard.js');

describe('acknowledgeSecret', () => {
  it('shows the whole token, and copying it closes the screen', async () => {
    const titles: string[] = [];
    const answers = ['copy', 'ok'];
    const result = await acknowledgeSecret(async (t) => { titles.push(t); return answers.shift(); }, 'Token: mdt_x', 'mdt_x');
    expect(result).toBe('copied');
    expect(titles).toEqual(['Token: mdt_x']);
    expect(vi.mocked(spawnSync).mock.calls[0][2]).toMatchObject({ input: 'mdt_x' });
  });

  it('stays open when the clipboard can\'t be reached, until done', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    const titles: string[] = [];
    const answers = ['copy', 'ok'];
    const result = await acknowledgeSecret(async (t) => { titles.push(t); return answers.shift(); }, 'Token: mdt_x', 'mdt_x');
    expect(result).toBe('ok');
    expect(titles[1]).toContain("Couldn't reach the clipboard");
  });

  it('without a value to copy, offers only the acknowledgement', async () => {
    const seen: string[][] = [];
    await acknowledgeSecret(async (_t, o) => { seen.push(o.map((x) => x.value)); return 'ok'; }, 'hello');
    expect(seen).toEqual([['ok']]);
  });
});
