import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../../utils/ssrf.js';

export const MAX_RESOURCE_BYTES = 2_000_000;
export const MAX_PAGE_BYTES = 8_000_000;

/** Shared by every response in one navigation. Failed/aborted transfers do not
 * refund bytes. Exhaustion cancels all active requests before more are admitted. */
export class BrowserByteBudget {
  private used = 0;
  private controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  consume(bytes: number): void {
    this.signal.throwIfAborted();
    if (bytes > MAX_PAGE_BYTES - this.used) {
      const error = new Error('Browser page exceeded its download budget.');
      this.controller.abort(error);
      throw error;
    }
    this.used += bytes;
  }
}

export interface BrowserResponse { status: number; headers: Record<string, string>; body: Buffer }
export type BrowserTransport = (url: URL, signal: AbortSignal, budget: BrowserByteBudget) => Promise<BrowserResponse>;

/** Deliberately stricter than fetch_url: no environment override, credentials,
 * alternate ports, unresolved host fallback, or automatic redirect following. */
export function browserUrl(raw: string): URL {
  if (raw.length > 4_096) throw new Error('Browser URL is too long.');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Browser navigation requires HTTP(S), default ports, and no URL credentials.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if ((!isIP(host) && (!host.includes('.') || /\.(?:localhost|local|internal|onion)$/.test(host)))
    || (isIP(host) && !isPublicBrowserAddress(host))) throw new Error('Browser blocked a private/internal address.');
  url.hash = '';
  return url;
}

export function isPublicBrowserAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || isPrivateAddress(address)) return false;
  if (family === 4) return !address.startsWith('192.88.99.');
  // Accept global unicast only, excluding translation, tunneling, documentation,
  // and IETF special-purpose ranges (some embed otherwise hidden private IPv4).
  const words = address.toLowerCase().split(':');
  const first = parseInt(words[0]!, 16);
  const second = parseInt(words[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && second < 0x200)
    && !(first === 0x3fff && second < 0x1000);
}

export async function resolveBrowserAddress(url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicBrowserAddress(address))) {
    throw new Error('Browser blocked DNS with a private, special-use, or missing address.');
  }
  return addresses[0]!;
}

export const requestPublicResource = async (input: URL, signal: AbortSignal, budget = new BrowserByteBudget()): Promise<BrowserResponse> => {
  signal = AbortSignal.any([signal, budget.signal]);
  signal.throwIfAborted();
  const url = browserUrl(input.href);
  const pinned = await resolveBrowserAddress(url);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // A fresh connection per bounded request: the validated IP cannot be replaced
    // by a second DNS lookup, a global pin table, a proxy env var, or a pooled socket.
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false,
      signal,
      method: 'GET',
      headers: { 'User-Agent': 'Mercury-Isolated-Reader/1.0', Accept: '*/*', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        try { budget.consume(chunk.length); } catch (error) { res.destroy(error as Error); return; }
        bytes += chunk.length;
        if (bytes > MAX_RESOURCE_BYTES) res.destroy(new Error('Browser resource exceeds 2 MB.'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'location', 'content-disposition', 'content-encoding']) {
          const value = res.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        resolve({ status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Browser resource timed out.')));
    req.end();
  });
};
