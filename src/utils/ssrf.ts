/**
 * SSRF guard shared by every tool that fetches remote content (web pages,
 * skill installs). The model fetches URLs at the instruction of whoever it
 * is talking to — or of content it fetched earlier — so every target must
 * be validated: scheme, literal hosts, DNS-resolved addresses, and every
 * redirect hop (redirect: 'manual' — a public URL must not be able to hop
 * into a private one).
 *
 * Validation and connection are kept on the same address: the hostname is
 * resolved here, any answer containing a non-global address is rejected
 * (fail closed on DNS mixed answers), and the connection is pinned to the
 * exact address that was validated so a hostile resolver cannot swap in a
 * private address between the check and the fetch (TOCTOU / DNS rebinding).
 */

import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mercury-Agent/0.1.0',
  'Accept': 'text/html,application/json,text/plain',
};

const ALLOW_PRIVATE_FETCH = process.env.MERCURY_ALLOW_PRIVATE_FETCH === '1';

export const MAX_REDIRECTS = 5;

function isPrivateIpv4(ip: string): boolean {
  const v4 = ip.split('.').map((p) => parseInt(p, 10));
  if (v4.length !== 4 || v4.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = v4;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  // Special-use / non-global blocks (RFC 6890): benchmarking, IETF protocol
  // assignments and the TEST-NET ranges. Not globally routable, so not valid
  // fetch targets.
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  const head = lower.split(':')[0] ?? '';
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^fe[c-f]/.test(head)) return true; // fec0::/10 site-local (deprecated)
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique local
  if (/^ff/.test(head)) return true; // ff00::/8 multicast
  if (lower.startsWith('2001:db8')) return true; // 2001:db8::/32 documentation
  return false;
}

/**
 * Link-local addresses, where cloud metadata services live (169.254.169.254,
 * fd00:ec2::254 is unique-local and stays private). `allowPrivate` opens
 * loopback and the LAN, never these: a metadata endpoint hands out the
 * machine's cloud credentials.
 */
export function isLinkLocalAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  if (isIP(v4) === 4) return v4.startsWith('169.254.');
  return isIP(lower) === 6 && /^fe[89ab]/.test(lower.split(':')[0] ?? '');
}

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

function urlHostIsPrivate(hostname: string): boolean {
  // Literal IP in the URL — no DNS needed.
  if (isIP(hostname)) return isPrivateAddress(hostname);
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  return false;
}

const DEFAULT_PRIVATE_HINT = 'Set MERCURY_ALLOW_PRIVATE_FETCH=1 to allow fetching internal hosts.';

function privateBlockReason(host: string, hint = DEFAULT_PRIVATE_HINT): Error {
  return new Error(`Blocked: ${host} is a private/internal address (SSRF protection). ${hint}`);
}

function lookupHost(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(addresses) ? addresses.map((a) => a.address) : [String(addresses)]);
    });
  });
}

type PinnedAddress = { address: string; family: number };
type ResolvedTarget = { url: URL; pinned?: PinnedAddress };

async function resolveAndValidate(rawUrl: string, allowPrivate = false, privateHint?: string): Promise<ResolvedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked scheme: ${parsed.protocol} — only http and https are allowed`);
  }
  if (allowPrivate) {
    // Loopback and the LAN are allowed; link-local (cloud metadata) never is.
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (METADATA_HOSTS.has(host)) throw new Error(`Blocked: ${host} is a cloud metadata service`);
    const literal = isIP(host);
    if (literal !== 0) {
      if (isLinkLocalAddress(host)) throw new Error(`Blocked: ${host} is link-local (cloud metadata)`);
      return { url: parsed, pinned: { address: host, family: literal } };
    }
    const resolved = await lookupHost(host);
    if (resolved.some(isLinkLocalAddress)) throw new Error(`Blocked: ${host} resolves to a link-local (cloud metadata) address`);
    return { url: parsed, ...(resolved[0] ? { pinned: { address: resolved[0], family: isIP(resolved[0]) } } : {}) };
  }
  if (urlHostIsPrivate(parsed.hostname)) {
    throw privateBlockReason(parsed.hostname, privateHint);
  }
  if (ALLOW_PRIVATE_FETCH) {
    return { url: parsed };
  }
  const literalFamily = isIP(parsed.hostname);
  if (literalFamily !== 0) {
    return { url: parsed, pinned: { address: parsed.hostname, family: literalFamily } };
  }
  const addresses = await lookupHost(parsed.hostname);
  if (addresses.length === 0) {
    // Nothing resolved — let the fetch fail on its own rather than guessing.
    return { url: parsed };
  }
  // Fail closed on DNS mixed answers: one non-global record is enough to
  // refuse the target, because we cannot know which record a re-resolving
  // connection would have picked.
  const offending = addresses.find((ip) => isPrivateAddress(ip));
  if (offending) {
    throw privateBlockReason(parsed.hostname, privateHint);
  }
  const chosen = addresses[0]!;
  return { url: parsed, pinned: { address: chosen, family: isIP(chosen) } };
}

/** Throws with a human-readable reason when the URL must not be fetched. */
export async function assertFetchableTarget(rawUrl: string): Promise<URL> {
  return (await resolveAndValidate(rawUrl)).url;
}

// Pinned lookups for the current in-flight requests, keyed by hostname. The
// guarded agent consults this table so its connection goes to the exact
// address that was validated instead of re-resolving.
const pinnedByHost = new Map<string, PinnedAddress>();

const guardedAgent = new Agent({
  connect: {
    // undici types this hook against its internal LookupFunction; the shape
    // below matches what it invokes at connect time.
    lookup: ((hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
      const pinned = pinnedByHost.get(hostname);
      if (!pinned) {
        (lookup as unknown as (host: string, opts: unknown, cb: unknown) => void)(hostname, options, callback);
        return;
      }
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as never,
  },
});

type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

/** Fetch with SSRF validation on the initial URL AND every redirect hop. */
export async function guardedFetch(rawUrl: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, pinned } = await resolveAndValidate(target);
    const host = url.hostname;
    if (pinned) pinnedByHost.set(host, pinned);
    try {
      const init: FetchInitWithDispatcher = {
        signal,
        redirect: 'manual',
        headers: headers ?? DEFAULT_HEADERS,
        dispatcher: guardedAgent,
      };
      const resp = await fetch(url, init);
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (location) {
          try { void resp.body?.cancel(); } catch { /* best effort */ }
          target = new URL(location, url).href;
          continue;
        }
      }
      return resp;
    } finally {
      if (pinned && pinnedByHost.get(host)?.address === pinned.address) {
        pinnedByHost.delete(host);
      }
    }
  }
  throw new Error('Blocked: too many redirects');
}

export type GuardedFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class PinTable {
  private readonly pins = new Map<string, { pin: { address: string; family: number }; count: number }>();

  acquire(host: string, pin: { address: string; family: number }): void {
    const entry = this.pins.get(host);
    this.pins.set(host, { pin, count: (entry?.count ?? 0) + 1 });
  }

  release(host: string): void {
    const entry = this.pins.get(host);
    if (!entry) return;
    if (entry.count <= 1) this.pins.delete(host);
    else entry.count -= 1;
  }

  get(host: string): { address: string; family: number } | undefined {
    return this.pins.get(host)?.pin;
  }
}

const guardedFetchPins = new PinTable();

const guardedFetchAgent = new Agent({
  connect: {
    lookup: ((hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
      const pinned = guardedFetchPins.get(hostname);
      if (!pinned) {
        (lookup as unknown as (host: string, opts: unknown, cb: unknown) => void)(hostname, options, callback);
        return;
      }
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as never,
  },
});

export function createGuardedFetch(options: { allowPrivate?: boolean; privateHint?: string } = {}): GuardedFetchLike {
  return async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.href;
    const { url, pinned } = await resolveAndValidate(href, options.allowPrivate === true, options.privateHint);
    const host = url.hostname;
    if (pinned) guardedFetchPins.acquire(host, pinned);
    try {
      const guardedInit: FetchInitWithDispatcher = { ...init, redirect: 'manual', dispatcher: guardedFetchAgent };
      return await fetch(url, guardedInit);
    } finally {
      if (pinned) guardedFetchPins.release(host);
    }
  };
}
