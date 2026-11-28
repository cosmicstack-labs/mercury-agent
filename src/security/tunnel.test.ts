import { describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { answersHere, checkHereAnswers, choosePairAddress, hostAllowsPlainHttp, isLoopbackHost, isOwnAddress, ownHosts, parseServeStatus, readTailscale, type TailscaleState } from './tunnel.js';

const PORT = 6174;
const HOST = 'mercury.tail1234.ts.net';

const serveHttps = (host = HOST, port = 443, proxy = 'http://127.0.0.1:6174') => ({
  TCP: { [String(port)]: { HTTPS: true } },
  Web: { [`${host}:${port}`]: { Handlers: { '/': { Proxy: proxy } } } },
});

const serveHttp = (host = HOST, port = 80) => ({
  TCP: { [String(port)]: { HTTP: true } },
  Web: { [`${host}:${port}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:6174' } } } },
});

const running = { BackendState: 'Running', CertDomains: [HOST], CurrentTailnet: { Name: 'example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true } };

function fakeTailscale(status: unknown, serve: unknown) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const out = args[0] === 'status' ? status : serve;
    return out === null ? null : typeof out === 'string' ? out : JSON.stringify(out);
  };
  return { run, calls };
}

const state = (serve: TailscaleState['serve'], extra: Partial<TailscaleState> = {}): TailscaleState => ({ magicDns: true, httpsCerts: true, serve, ...extra });

describe('plain http, by the phone apps rule', () => {
  it.each([
    'localhost', 'app.localhost', 'mymac.local', 'MyMac.Local.', 'mymac',
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '100.64.0.1', '100.127.255.255',
    '::1', '[::1]', 'fd12:3456::1', 'fc00::1', 'fe80::1', '[fe80::1]',
  ])('allows %s', (host) => {
    expect(hostAllowsPlainHttp(host)).toBe(true);
  });

  it.each([
    '', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8', '203.0.113.7', '256.1.1.1', '1.2.3',
    HOST, 'example.com', '2001:db8::1', '::ffff:10.0.0.1',
  ])('refuses %s', (host) => {
    expect(hostAllowsPlainHttp(host)).toBe(false);
  });

  it('knows loopback addresses', () => {
    expect(['localhost', 'a.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]'].every(isLoopbackHost)).toBe(true);
    expect(['192.168.1.5', HOST, 'mymac', '::2'].some(isLoopbackHost)).toBe(false);
  });
});

describe('tailscale serve status --json', () => {
  it('finds an HTTPS address that forwards to Mercury', () => {
    expect(parseServeStatus(serveHttps(), PORT)).toEqual([{ url: `https://${HOST}`, https: true, funnel: false }]);
  });

  it('keeps a port other than 443, and reads foreground configs', () => {
    const json = { Foreground: { abc123: serveHttps(HOST, 8443) } };
    expect(parseServeStatus(json, PORT)).toEqual([{ url: `https://${HOST}:8443`, https: true, funnel: false }]);
  });

  it('accepts the proxy forms Tailscale writes', () => {
    for (const proxy of ['http://127.0.0.1:6174', 'http://localhost:6174', '127.0.0.1:6174', '6174', 'http://127.0.0.1:6174/']) {
      expect(parseServeStatus(serveHttps(HOST, 443, proxy), PORT)).toHaveLength(1);
    }
  });

  it('ignores what forwards somewhere else, or only under a path', () => {
    expect(parseServeStatus(serveHttps(HOST, 443, 'http://127.0.0.1:3000'), PORT)).toEqual([]);
    expect(parseServeStatus(serveHttps(HOST, 443, 'http://10.0.0.5:6174'), PORT)).toEqual([]);
    const underPath = { TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/mercury': { Proxy: 'http://127.0.0.1:6174' } } } } };
    expect(parseServeStatus(underPath, PORT)).toEqual([]);
  });

  it('reports plain http serving, after HTTPS', () => {
    const json = { TCP: { ...serveHttp().TCP, ...serveHttps().TCP }, Web: { ...serveHttp().Web, ...serveHttps().Web } };
    expect(parseServeStatus(json, PORT)).toEqual([
      { url: `https://${HOST}`, https: true, funnel: false },
      { url: `http://${HOST}`, https: false, funnel: false },
    ]);
  });

  it('notes Funnel', () => {
    const json = { ...serveHttps(), AllowFunnel: { [`${HOST}:443`]: true } };
    expect(parseServeStatus(json, PORT)[0].funnel).toBe(true);
  });

  it('reads nothing from an empty or odd answer', () => {
    expect(parseServeStatus({}, PORT)).toEqual([]);
    expect(parseServeStatus(null, PORT)).toEqual([]);
    expect(parseServeStatus([], PORT)).toEqual([]);
    expect(parseServeStatus({ Web: { 'no-port': { Handlers: { '/': { Proxy: '6174' } } } } }, PORT)).toEqual([]);
  });
});

describe('reading Tailscale', () => {
  it('is null, quietly, when Tailscale is not installed', () => {
    const { run, calls } = fakeTailscale(null, null);
    expect(readTailscale({ port: PORT, run })).toBeNull();
    expect(calls).toEqual([['status', '--json', '--peers=false']]);
  });

  it('is null when Tailscale is not running or answers nonsense', () => {
    expect(readTailscale({ port: PORT, run: fakeTailscale({ BackendState: 'NeedsLogin' }, {}).run })).toBeNull();
    expect(readTailscale({ port: PORT, run: fakeTailscale('not json', {}).run })).toBeNull();
  });

  it('reads MagicDNS, HTTPS certificates and what Serve forwards to Mercury', () => {
    const { run, calls } = fakeTailscale(running, serveHttps());
    expect(readTailscale({ port: PORT, run })).toEqual(state([{ url: `https://${HOST}`, https: true, funnel: false }]));
    expect(calls).toEqual([['status', '--json', '--peers=false'], ['serve', 'status', '--json']]);
  });

  it('sees HTTPS certificates and MagicDNS turned off', () => {
    const off = { BackendState: 'Running', CertDomains: null, CurrentTailnet: { MagicDNSEnabled: false } };
    expect(readTailscale({ port: PORT, run: fakeTailscale(off, 'garbled').run })).toEqual({ magicDns: false, httpsCerts: false, serve: [] });
  });
});

describe('the address a phone is given', () => {
  const none = { port: PORT, tailscale: null, publicUrl: null };

  it('uses the address the owner gives, as an origin', () => {
    expect(choosePairAddress('https://Mercury.Example.com/some/path/', none)).toEqual({ ok: true, address: 'https://mercury.example.com', source: 'given' });
    expect(choosePairAddress('mercury.example.com', none)).toEqual({ ok: true, address: 'https://mercury.example.com', source: 'given' });
    expect(choosePairAddress('http://192.168.1.5:6174', none)).toEqual({ ok: true, address: 'http://192.168.1.5:6174', source: 'given' });
    expect(choosePairAddress('http://100.101.102.103', none)).toEqual({ ok: true, address: 'http://100.101.102.103', source: 'given' });
  });

  it('prefers what the owner gives over Tailscale and the config', () => {
    const r = choosePairAddress('https://other.example.com', { port: PORT, tailscale: state([{ url: `https://${HOST}`, https: true, funnel: false }]), publicUrl: 'https://config.example.com' });
    expect(r).toEqual({ ok: true, address: 'https://other.example.com', source: 'given' });
  });

  it('refuses plain http outside the owner network, naming how to get HTTPS', () => {
    const r = choosePairAddress('http://203.0.113.7:8080', none);
    expect(r).toMatchObject({ ok: false, reason: 'insecure' });
    expect(r.ok ? '' : r.message).toContain('tailscale serve --bg 6174');
    expect(r.ok ? '' : r.message).toContain('Cloudflare Tunnel');
    expect(choosePairAddress(`http://${HOST}`, none)).toMatchObject({ ok: false, reason: 'insecure' });
  });

  it("refuses this computer's own addresses and things that aren't web addresses", () => {
    expect(choosePairAddress('http://127.0.0.1:6174', none)).toMatchObject({ ok: false, reason: 'loopback' });
    expect(choosePairAddress('https://localhost', none)).toMatchObject({ ok: false, reason: 'loopback' });
    expect(choosePairAddress('ftp://files.example.com', none)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(choosePairAddress('https://', none)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('takes the saved address (web.publicUrl) first, then the Tailscale Serve HTTPS address', () => {
    const tailscale = state([{ url: `http://${HOST}`, https: false, funnel: false }, { url: `https://${HOST}`, https: true, funnel: false }]);
    expect(choosePairAddress(undefined, { port: PORT, tailscale, publicUrl: 'https://config.example.com' })).toEqual({ ok: true, address: 'https://config.example.com', source: 'config' });
    expect(choosePairAddress(undefined, { port: PORT, tailscale, publicUrl: null })).toEqual({ ok: true, address: `https://${HOST}`, source: 'tailscale' });
    expect(choosePairAddress(undefined, { port: PORT, tailscale: null, publicUrl: 'https://config.example.com/' })).toEqual({ ok: true, address: 'https://config.example.com', source: 'config' });
    expect(choosePairAddress('  ', { port: PORT, tailscale: state([]), publicUrl: 'https://config.example.com' })).toMatchObject({ ok: true, source: 'config' });
  });

  it('says which setting is wrong when web.publicUrl is plain http to the internet', () => {
    const r = choosePairAddress(undefined, { port: PORT, tailscale: null, publicUrl: 'http://mercury.example.com' });
    expect(r).toMatchObject({ ok: false, reason: 'insecure' });
    expect(r.ok ? '' : r.message).toMatch(/^web\.publicUrl/);
  });

  it('refuses Tailscale Serve over plain http, with the HTTPS switches to turn on', () => {
    const r = choosePairAddress(undefined, { port: 7000, tailscale: state([{ url: `http://${HOST}`, https: false, funnel: false }], { httpsCerts: false }), publicUrl: null });
    expect(r).toMatchObject({ ok: false, reason: 'insecure' });
    expect(r.ok ? '' : r.message).toContain('MagicDNS and HTTPS Certificates');
    expect(r.ok ? '' : r.message).toContain('tailscale serve --bg 7000');
  });

  it('says how to get an address when there is none', () => {
    const r = choosePairAddress(undefined, none);
    expect(r).toMatchObject({ ok: false, reason: 'none' });
    expect(r.ok ? '' : r.message).toContain('tailscale serve --bg 6174');
    expect(r.ok ? '' : r.message).toContain('web.publicUrl');
  });
});

describe('an address on this computer', () => {
  const own = () => new Set(['192.168.1.5', 'fd12::5', '100.101.102.103', 'mymac', 'mymac.local']);
  const chosen = (address: string, source: 'given' | 'tailscale' | 'config' = 'given') => ({ ok: true as const, address, source });

  function probe(answer: boolean) {
    const calls: Array<[string, number]> = [];
    const answers = async (host: string, port: number) => { calls.push([host, port]); return answer; };
    return { calls, deps: { port: 6174, ownHosts: own, answers } };
  }

  it("doesn't probe an address on another machine", async () => {
    const p = probe(false);
    expect(await checkHereAnswers(chosen('http://192.168.1.9:6174'), p.deps)).toEqual(chosen('http://192.168.1.9:6174'));
    expect(await checkHereAnswers(chosen(`https://${HOST}`, 'tailscale'), p.deps)).toEqual(chosen(`https://${HOST}`, 'tailscale'));
    expect(p.calls).toEqual([]);
  });

  it('refuses this computer\'s own address when nothing answers there', async () => {
    const p = probe(false);
    const r = await checkHereAnswers(chosen('http://192.168.1.5:6174'), p.deps);
    expect(p.calls).toEqual([['192.168.1.5', 6174]]);
    expect(r).toEqual({
      ok: false,
      reason: 'loopback',
      message: "Nothing on this computer answers at http://192.168.1.5:6174, and Mercury itself only listens on 127.0.0.1, so your phone can't reach it there. Use Tailscale Serve (tailscale serve --bg 6174), or start the proxy that should listen at that address.",
    });
  });

  it('accepts this computer\'s own address when a proxy answers there', async () => {
    const p = probe(true);
    expect(await checkHereAnswers(chosen('http://192.168.1.5:8080'), p.deps)).toEqual(chosen('http://192.168.1.5:8080'));
    expect(p.calls).toEqual([['192.168.1.5', 8080]]);
  });

  it('knows this computer by its name and name.local, in any case, and its Tailscale address', async () => {
    const p = probe(false);
    for (const address of ['http://MyMac:8080', 'http://mymac.LOCAL:8080', 'http://100.101.102.103:6174']) {
      expect(await checkHereAnswers(chosen(address), p.deps)).toMatchObject({ ok: false, reason: 'loopback' });
    }
    expect(p.calls.map((c) => c[0].toLowerCase())).toEqual(['mymac', 'mymac.local', '100.101.102.103']);
  });

  it('probes IPv6 and the default ports', async () => {
    const p = probe(true);
    await checkHereAnswers(chosen('http://[fd12::5]'), p.deps);
    await checkHereAnswers(chosen('https://192.168.1.5'), p.deps);
    expect(p.calls).toEqual([['[fd12::5]', 80], ['192.168.1.5', 443]]);
  });

  it('says which setting is wrong when it is web.publicUrl', async () => {
    const r = await checkHereAnswers(chosen('http://192.168.1.5:6174', 'config'), probe(false).deps);
    expect(r.ok ? '' : r.message).toMatch(/^web\.publicUrl in ~\/\.mercury\/mercury\.yaml: Nothing on this computer answers/);
  });

  it('reads this computer\'s own names and addresses from the system', () => {
    const name = hostname().toLowerCase();
    expect(ownHosts().has(name)).toBe(true);
    expect(isOwnAddress(hostname().toUpperCase())).toBe(true);
    expect(isOwnAddress(`${name}.local`)).toBe(true);
    expect(isOwnAddress('mercury.example.com')).toBe(false);
  });

  it('really connects: a listening port answers, a closed one does not', async () => {
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    expect(await answersHere('127.0.0.1', port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await answersHere('127.0.0.1', port)).toBe(false);
  });
});
