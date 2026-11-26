import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../utils/config.js';
import { getWebPort } from '../web/auth.js';

export interface TailscaleServe {
  url: string;
  https: boolean;
  funnel: boolean;
}

export interface TailscaleState {
  magicDns: boolean;
  httpsCerts: boolean;
  serve: TailscaleServe[];
}

export type RunTailscale = (args: string[]) => string | null;

export type PairAddress =
  | { ok: true; address: string; source: 'given' | 'tailscale' | 'config' }
  | { ok: false; reason: 'none' | 'insecure' | 'loopback' | 'invalid'; message: string };

export interface PairAddressDeps {
  port?: number;
  tailscale?: TailscaleState | null;
  publicUrl?: string | null;
}

const TAILSCALE_CACHE_MS = 30_000;

function ipv4(h: string): number[] | null {
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivate4(b: number[]): boolean {
  if (b[0] === 127 || b[0] === 10) return true;
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true;
  if (b[0] === 192 && b[1] === 168) return true;
  if (b[0] === 169 && b[1] === 254) return true;
  return b[0] === 100 && b[1] >= 64 && b[1] <= 127;
}

function isPrivate6(h: string): boolean {
  if (h === '::1') return true;
  const head = h.split(':')[0];
  if (!head || !/^[0-9a-f]{1,4}$/.test(head)) return false;
  const first = parseInt(head, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
}

export function hostAllowsPlainHttp(host: string): boolean {
  const h = bareHost(host);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const v4 = ipv4(h);
  if (v4) return isPrivate4(v4);
  if (h.includes(':')) return isPrivate6(h);
  return !h.includes('.');
}

export function isLoopbackHost(host: string): boolean {
  const h = bareHost(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  return ipv4(h)?.[0] === 127;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function proxiesTo(proxy: unknown, port: number): boolean {
  if (typeof proxy !== 'string') return false;
  const m = /^(?:https?(?:\+insecure)?:\/\/)?(?:(?:127\.0\.0\.1|localhost|\[::1\]):)?(\d+)\/?$/i.exec(proxy.trim());
  return !!m && Number(m[1]) === port;
}

export function parseServeStatus(json: unknown, port: number): TailscaleServe[] {
  const root = asRecord(json);
  if (!root) return [];
  const configs = [root, ...Object.values(asRecord(root.Foreground) ?? {}).map(asRecord).filter((c): c is Record<string, unknown> => !!c)];
  const out: TailscaleServe[] = [];
  for (const cfg of configs) {
    const tcp = asRecord(cfg.TCP) ?? {};
    const funnel = asRecord(cfg.AllowFunnel) ?? {};
    for (const [hostPort, web] of Object.entries(asRecord(cfg.Web) ?? {})) {
      const mount = asRecord(asRecord(asRecord(web)?.Handlers)?.['/']);
      if (!proxiesTo(mount?.Proxy, port)) continue;
      const i = hostPort.lastIndexOf(':');
      const host = hostPort.slice(0, i);
      const p = Number(hostPort.slice(i + 1));
      if (i <= 0 || !Number.isInteger(p) || p <= 0) continue;
      const listener = asRecord(tcp[String(p)]);
      const https = listener?.HTTPS === true;
      if (!https && listener?.HTTP !== true) continue;
      const url = `${https ? 'https' : 'http'}://${host}${p === (https ? 443 : 80) ? '' : `:${p}`}`;
      if (!out.some((s) => s.url === url)) out.push({ url, https, funnel: funnel[hostPort] === true });
    }
  }
  return out.sort((a, b) => Number(b.https) - Number(a.https));
}

function tailscaleCommands(): string[] {
  const out = ['tailscale'];
  if (process.platform === 'darwin') out.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  if (process.platform === 'win32') out.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
  return out;
}

function runTailscale(args: string[]): string | null {
  for (const cmd of tailscaleCommands()) {
    if (cmd !== 'tailscale' && !existsSync(cmd)) continue;
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return null;
    }
    return r.status === 0 ? r.stdout : null;
  }
  return null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function probeTailscale(run: RunTailscale, port: number): TailscaleState | null {
  const status = asRecord(parseJson(run(['status', '--json', '--peers=false'])));
  if (!status || status.BackendState !== 'Running') return null;
  const certs = status.CertDomains;
  return {
    magicDns: asRecord(status.CurrentTailnet)?.MagicDNSEnabled === true,
    httpsCerts: Array.isArray(certs) && certs.length > 0,
    serve: parseServeStatus(parseJson(run(['serve', 'status', '--json'])), port),
  };
}

let cached: { at: number; port: number; value: TailscaleState | null } | null = null;

export function readTailscale(opts: { port: number; run?: RunTailscale }): TailscaleState | null {
  if (opts.run) return probeTailscale(opts.run, opts.port);
  const now = Date.now();
  if (cached && cached.port === opts.port && now - cached.at < TAILSCALE_CACHE_MS) return cached.value;
  const value = probeTailscale(runTailscale, opts.port);
  cached = { at: now, port: opts.port, value };
  return value;
}

export function configuredPublicUrl(): string | null {
  try {
    const v = loadConfig().web?.publicUrl;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function toUrl(input: string): URL | null {
  const s = input.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function checkAddress(input: string, source: 'given' | 'tailscale' | 'config', port: number): PairAddress {
  const u = toUrl(input);
  const where = source === 'config' ? 'web.publicUrl in ~/.mercury/mercury.yaml: ' : '';
  if (!u || !u.hostname) {
    return { ok: false, reason: 'invalid', message: `${where}“${input.trim()}” isn't a web address. Give the https:// address your phone opens Mercury at, for example https://mercury.example.com.` };
  }
  if (isLoopbackHost(u.hostname)) {
    return { ok: false, reason: 'loopback', message: `${where}${u.origin} only works on this computer, so your phone can't reach it. Give the address of a tunnel to Mercury instead, such as Tailscale Serve or a Cloudflare Tunnel.` };
  }
  if (u.protocol === 'http:' && !hostAllowsPlainHttp(u.hostname)) {
    return { ok: false, reason: 'insecure', message: `${where}${u.origin} is plain http to an address outside your own network. The phone apps refuse it, and anyone along the way could read it. Put Mercury behind HTTPS first: tailscale serve --bg ${port} with Tailscale, or a Cloudflare Tunnel. Then pair with the https:// address.` };
  }
  return { ok: true, address: u.origin, source };
}

export function choosePairAddress(given?: string, deps: PairAddressDeps = {}): PairAddress {
  const port = deps.port ?? getWebPort();
  if (given?.trim()) return checkAddress(given, 'given', port);
  const tailscale = deps.tailscale !== undefined ? deps.tailscale : readTailscale({ port });
  const viaTailscale = tailscale?.serve.find((s) => s.https);
  if (viaTailscale) return checkAddress(viaTailscale.url, 'tailscale', port);
  const configured = deps.publicUrl !== undefined ? deps.publicUrl : configuredPublicUrl();
  if (configured) return checkAddress(configured, 'config', port);
  const plain = tailscale?.serve.find((s) => !s.https);
  if (plain) {
    return { ok: false, reason: 'insecure', message: `Tailscale Serve sends ${plain.url} to Mercury over plain http, which the phone apps refuse. In the Tailscale admin console, open DNS and turn on MagicDNS and HTTPS Certificates, then run tailscale serve --bg ${port}.` };
  }
  return { ok: false, reason: 'none', message: `Mercury doesn't know an address your phone can reach. With Tailscale, run tailscale serve --bg ${port} and pair again. With another tunnel, add its https:// address after pair (for example pair https://mercury.example.com), or set web.publicUrl in ~/.mercury/mercury.yaml.` };
}

export interface HereDeps {
  port?: number;
  ownHosts?: () => Set<string>;
  answers?: (host: string, port: number) => Promise<boolean>;
}

const plainHost = (host: string): string => bareHost(host).replace(/%.*$/, '');

export function ownHosts(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.add(plainHost(a.address));
  }
  const name = hostname().trim().toLowerCase();
  if (name) {
    out.add(name);
    out.add(`${name}.local`);
  }
  return out;
}

export function isOwnAddress(host: string, own: Set<string> = ownHosts()): boolean {
  return own.has(plainHost(host));
}

export function answersHere(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: plainHost(host), port });
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function checkHereAnswers(chosen: Extract<PairAddress, { ok: true }>, deps: HereDeps = {}): Promise<PairAddress> {
  const u = new URL(chosen.address);
  if (!isOwnAddress(u.hostname, (deps.ownHosts ?? ownHosts)())) return chosen;
  const target = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (await (deps.answers ?? answersHere)(u.hostname, target)) return chosen;
  const where = chosen.source === 'config' ? 'web.publicUrl in ~/.mercury/mercury.yaml: ' : '';
  return {
    ok: false,
    reason: 'loopback',
    message: `${where}Nothing on this computer answers at ${u.origin}, and Mercury itself only listens on 127.0.0.1, so your phone can't reach it there. Use Tailscale Serve (tailscale serve --bg ${deps.port ?? getWebPort()}), or start the proxy that should listen at that address.`,
  };
}
