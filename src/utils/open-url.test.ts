import { describe, expect, it, vi } from 'vitest';
import { getUrlOpeners, openUrl } from './open-url.js';

describe('URL opening', () => {
  it('prefers termux-open-url and falls back to xdg-open on Termux', () => {
    expect(getUrlOpeners('https://example.com', { TERMUX_VERSION: '0.119' }, 'linux')).toEqual([
      { command: 'termux-open-url', args: ['https://example.com'] },
      { command: 'xdg-open', args: ['https://example.com'] },
    ]);
  });

  it("hands Windows the whole URL, so cmd.exe can't cut it at an &", () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A5&scope=a';
    expect(getUrlOpeners(url, {}, 'win32')[0]).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
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
