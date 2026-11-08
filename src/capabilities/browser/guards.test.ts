import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { browserUrl, isPublicBrowserAddress, resolveBrowserAddress } from './public-request.js';
import { browserArgs, browserCandidates, browserEnvironment } from './launch.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('isolated browser public network boundary', () => {
  it.each([
    'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://router.local/',
    'http://metadata.google.internal/', 'http://192.168.1.1/', 'http://10.0.0.1/',
    'http://100.64.0.1/', 'http://198.18.0.1/', 'http://example.com:8080/',
    'https://user:secret@example.com/', 'file:///etc/passwd', 'data:text/html,test',
    'javascript:alert(1)', 'ws://example.com/', 'wss://example.com/', 'chrome://settings/',
  ])('refuses %s before a browser or transport starts', (url) => expect(() => browserUrl(url)).toThrow());

  it.each(['0.0.0.0', '192.88.99.1', '224.0.0.1', '::', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001::1', '2002:7f00:1::', '3fff::1', 'fc00::1', 'fe80::1', 'not-an-ip'])('rejects non-global/special address %s', (address) => {
    expect(isPublicBrowserAddress(address)).toBe(false);
  });

  it('fails closed on mixed/private/empty DNS regardless of the generic private-fetch opt-in', async () => {
    vi.stubEnv('MERCURY_ALLOW_PRIVATE_FETCH', '1');
    for (const answers of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }]]) {
      vi.mocked(lookup).mockResolvedValue(answers as never);
      await expect(resolveBrowserAddress(browserUrl('https://public.example/'))).rejects.toThrow('Browser blocked DNS');
    }
    vi.unstubAllEnvs();
  });

  it('returns only the public address resolved for this request, including IPv6 global unicast', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    expect(await resolveBrowserAddress(browserUrl('https://public.example/'))).toEqual({ address: '93.184.216.34', family: 4 });
    expect(await resolveBrowserAddress(browserUrl('https://[2606:4700:4700::1111]/'))).toEqual({ address: '2606:4700:4700::1111', family: 6 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('installed browser launch contract', () => {
  it('uses private pipes, a fresh profile and default-deny proxy without disabling the Chromium sandbox', () => {
    const args = browserArgs('/tmp/fresh-profile', 12345);
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--proxy-server=http://127.0.0.1:12345');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args.some((arg) => /no-sandbox|disable-web-security|remote-debugging-port/.test(arg))).toBe(false);
  });

  it('finds Windows Chrome/Edge by absolute installed paths, never PATH commands or profile directories', () => {
    const paths = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'D:\\User\\AppData\\Local' });
    expect(paths).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(paths).toContain('D:\\User\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(browserCandidates('win32', { PROGRAMFILES: 'relative' })).toEqual([]);
  });

  it('does not inherit provider credentials, real home, debugging variables or proxy settings', () => {
    const env = browserEnvironment('/tmp/empty', { HOME: '/real', OPENAI_API_KEY: 'secret', SSH_AUTH_SOCK: '/agent', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--inspect', SystemRoot: 'C:\\Windows' });
    expect(env.HOME).toBe('/tmp/empty');
    expect(env.SystemRoot).toBe('C:\\Windows');
    for (const key of ['OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'NODE_OPTIONS']) expect(env[key]).toBeUndefined();
  });
});
