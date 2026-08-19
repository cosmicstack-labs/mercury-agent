import { describe, expect, it, vi } from 'vitest';
import { getUrlOpeners, openUrl } from './open-url.js';

describe('URL opening', () => {
  it('prefers termux-open-url and falls back to xdg-open on Termux', () => {
    expect(getUrlOpeners('https://example.com', { TERMUX_VERSION: '0.119' }, 'linux')).toEqual([
      { command: 'termux-open-url', args: ['https://example.com'] },
      { command: 'xdg-open', args: ['https://example.com'] },
    ]);
  });

  it('falls back safely and never throws when openers fail', async () => {
    const succeedsSecond = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce(undefined);
    const openers = getUrlOpeners('https://example.com', { TERMUX_VERSION: '0.119' }, 'linux');
    expect(await openUrl('https://example.com', succeedsSecond, openers)).toBe(true);

    const alwaysFails = vi.fn().mockRejectedValue(new Error('headless'));
    expect(await openUrl('https://example.com', alwaysFails, openers)).toBe(false);
  });
});
