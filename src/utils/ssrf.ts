/**
 * SSRF guard shared by every tool that fetches remote content (web pages,
 * skill installs). The model fetches URLs at the instruction of whoever it
 * is talking to — or of content it fetched earlier — so every target must
 * be validated: scheme, literal hosts, DNS-resolved addresses, and every
 * redirect hop (redirect: 'manual' — a public URL must not be able to hop
 * into a private one).
 */

import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 0) return false;
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const v4 = ip.split('.').map((p) => parseInt(p, 10));
  if (v4.length !== 4 || v4.some((p) => Number.isNaN(p))) return Boolean(ip.startsWith('::ffff:'));
  const [a, b] = v4;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

const ALLOW_PRIVATE_FETCH = process.env.MERCURY_ALLOW_PRIVATE_FETCH === '1';

function urlHostIsPrivate(hostname: string): boolean {
  // Literal IP in the URL — no DNS needed.
  if (isIP(hostname)) return isPrivateAddress(hostname);
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  return false;
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

/** Throws with a human-readable reason when the URL must not be fetched. */
export async function assertFetchableTarget(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked scheme: ${parsed.protocol} — only http and https are allowed`);
  }
  if (urlHostIsPrivate(parsed.hostname)) {
    throw privateBlockReason(parsed.hostname);
  }
  if (!ALLOW_PRIVATE_FETCH) {
    const addresses = await lookupHost(parsed.hostname);
    if (addresses.length > 0 && addresses.every((ip) => isPrivateAddress(ip))) {
      throw privateBlockReason(parsed.hostname);
    }
    // Mixed answers with at least one public address are allowed through
    // (CDNs occasionally return internal-looking extras).
  }
  return parsed;
}

function privateBlockReason(host: string): Error {
  return new Error(
    `Blocked: ${host} is a private/internal address (SSRF protection). ` +
    'Set MERCURY_ALLOW_PRIVATE_FETCH=1 to allow fetching internal hosts.',
  );
}

export const MAX_REDIRECTS = 5;

/** Fetch with SSRF validation on the initial URL AND every redirect hop. */
export async function guardedFetch(rawUrl: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertFetchableTarget(target);
    const resp = await fetch(validated, {
      signal,
      redirect: 'manual',
      headers: headers ?? {
        'User-Agent': 'Mercury-Agent/0.1.0',
        'Accept': 'text/html,application/json,text/plain',
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (location) {
        try { void resp.body?.cancel(); } catch { /* best effort */ }
        target = new URL(location, validated).href;
        continue;
      }
    }
    return resp;
  }
  throw new Error('Blocked: too many redirects');
}