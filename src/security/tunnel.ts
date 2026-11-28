import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/** Runs the tailscale CLI without blocking Mercury (the web server keeps answering meanwhile). */
function runTailscaleAsync(args: string[]): Promise<string | null> {
  const attempt = (cmds: string[]): Promise<string | null> => {
    const [cmd, ...rest] = cmds;
    if (!cmd) return Promise.resolve(null);
    if (cmd !== 'tailscale' && !existsSync(cmd)) return attempt(rest);
    return new Promise((resolve) => {
      execFile(cmd, args, { encoding: 'utf8', timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(attempt(rest)); return; }
        resolve(err ? null : stdout);
      });
    });
  };
  return attempt(tailscaleCommands());
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function stateFrom(status: Record<string, unknown> | null, serveJson: unknown, port: number): TailscaleState | null {
  if (!status || status.BackendState !== 'Running') return null;
  const certs = status.CertDomains;
  return {
    magicDns: asRecord(status.CurrentTailnet)?.MagicDNSEnabled === true,
    httpsCerts: Array.isArray(certs) && certs.length > 0,
    serve: parseServeStatus(serveJson, port),
  };
}

function probeTailscale(run: RunTailscale, port: number): TailscaleState | null {
  const status = asRecord(parseJson(run(['status', '--json', '--peers=false'])));
  if (!status || status.BackendState !== 'Running') return null;
  return stateFrom(status, parseJson(run(['serve', 'status', '--json'])), port);
}

let cached: { at: number; port: number; value: TailscaleState | null } | null = null;
let inflight: { port: number; done: Promise<TailscaleState | null> } | null = null;

/**
 * What Tailscale says, from the last look (at most 30 seconds old once
 * refreshTailscale ran). Never runs the CLI itself, so it never blocks.
 */
export function readTailscale(opts: { port: number; run?: RunTailscale }): TailscaleState | null {
  if (opts.run) return probeTailscale(opts.run, opts.port);
  return cached && cached.port === opts.port ? cached.value : null;
}

/** Look at Tailscale again if the last look is older than 30 seconds; callers await this before readTailscale. */
export async function refreshTailscale(opts: { port: number }): Promise<TailscaleState | null> {
  const now = Date.now();
  if (cached && cached.port === opts.port && now - cached.at < TAILSCALE_CACHE_MS) return cached.value;
  if (inflight?.port === opts.port) return inflight.done;
  const done = (async () => {
    const status = asRecord(parseJson(await runTailscaleAsync(['status', '--json', '--peers=false'])));
    const value = status && status.BackendState === 'Running'
      ? stateFrom(status, parseJson(await runTailscaleAsync(['serve', 'status', '--json'])), opts.port)
      : null;
    cached = { at: Date.now(), port: opts.port, value };
    return value;
  })().finally(() => { inflight = null; });
  inflight = { port: opts.port, done };
  return done;
}

export function _resetTailscaleCache(): void {
  cached = null;
  inflight = null;
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

export function checkAddress(input: string, source: 'given' | 'tailscale' | 'config', port: number): PairAddress {
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
  // The address the owner saved wins; Tailscale Serve is the fallback.
  const configured = deps.publicUrl !== undefined ? deps.publicUrl : configuredPublicUrl();
  if (configured) return checkAddress(configured, 'config', port);
  const tailscale = deps.tailscale !== undefined ? deps.tailscale : readTailscale({ port });
  const viaTailscale = tailscale?.serve.find((s) => s.https);
  if (viaTailscale) return checkAddress(viaTailscale.url, 'tailscale', port);
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

export type ReachResult = 'mercury' | 'other' | 'unreachable';

/** Nonces this Mercury is asking itself about right now (reachesMercury). */
const probes = new Map<string, number>();

/** /api/health answers a live probe nonce to anyone: it reveals nothing but that this is the Mercury that asked. */
export function isLiveProbe(nonce: string): boolean {
  const at = probes.get(nonce);
  return at !== undefined && Date.now() - at < 30_000;
}

/**
 * Does this address lead to this Mercury? Asks /api/health from here with a
 * one-time nonce. "Remote access is off" or "address not allowed" answers
 * also prove it is a Mercury.
 */
export async function reachesMercury(address: string, timeoutMs = 4000): Promise<ReachResult> {
  const nonce = randomBytes(12).toString('hex');
  probes.set(nonce, Date.now());
  try {
    const res = await fetch(`${address}/api/health?probe=${nonce}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.probe === nonce) return 'mercury';
    if (res.status === 403 && (body?.remoteOff === true || body?.addressBlocked === true)) return 'mercury';
    return 'other';
  } catch {
    return 'unreachable';
  } finally {
    probes.delete(nonce);
  }
}
