import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { guardedFetch } from '../utils/ssrf.js';

/**
 * Site icons for the apps' source lists, fetched by the runtime so the apps
 * themselves never load anything from a third party. Asked for by domain;
 * the site's own /favicon.ico first (the site was already visited by the
 * research), then DuckDuckGo's icon service for sites that only declare an
 * icon in their HTML. Cached on disk: an icon for 30 days, "no icon" for 7.
 * Only real images are kept and served; anything else is "no icon".
 */

const ICON_TTL_MS = 30 * 24 * 3600_000;
const MISS_TTL_MS = 7 * 24 * 3600_000;
const MAX_BYTES = 100_000;
const TIMEOUT_MS = 5_000;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A plain public host name ("www.bbc.co.uk"), lowercased, or null. IP addresses and "localhost" are not domains here. */
export function iconDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN.test(d) ? d : null;
}

/** What kind of image the bytes are, or null when they aren't one. */
export function imageMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 300).toString('utf-8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

async function fetchIcon(url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await guardedFetch(url, controller.signal, { 'User-Agent': 'Mercury', Accept: 'image/*' });
    if (!resp.ok) { void resp.body?.cancel(); return null; }
    const declared = Number(resp.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) { void resp.body?.cancel(); return null; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES || !imageMime(buf)) return null;
    // DuckDuckGo's placeholder for "no icon" is a tiny generic image: count it as none.
    if (url.includes('icons.duckduckgo.com') && buf.length < 120) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const inFlight = new Map<string, Promise<{ bytes: Buffer; mime: string } | null>>();

export class FaviconCache {
  constructor(private readonly dir = join(getMercuryHome(), 'cache', 'favicons'), private readonly fetcher: (url: string) => Promise<Buffer | null> = fetchIcon) {}

  /** The icon for a domain, or null when it has none (or isn't a public domain). */
  get(rawDomain: string, now = Date.now()): Promise<{ bytes: Buffer; mime: string } | null> {
    const domain = iconDomain(rawDomain);
    if (!domain) return Promise.resolve(null);
    const icon = join(this.dir, `${domain}.icon`);
    const miss = join(this.dir, `${domain}.none`);
    try {
      if (existsSync(icon) && now - statSync(icon).mtimeMs < ICON_TTL_MS) {
        const bytes = readFileSync(icon);
        const mime = imageMime(bytes);
        if (mime) return Promise.resolve({ bytes, mime });
      }
      if (existsSync(miss) && now - statSync(miss).mtimeMs < MISS_TTL_MS) return Promise.resolve(null);
    } catch { /* fetch again */ }
    const key = `${this.dir}:${domain}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const bytes = (await this.fetcher(`https://${domain}/favicon.ico`)) ?? (await this.fetcher(`https://icons.duckduckgo.com/ip3/${domain}.ico`));
        try {
          mkdirSync(this.dir, { recursive: true });
          writeFileSync(bytes ? icon : miss, bytes ?? '');
        } catch { /* serve it anyway */ }
        const mime = bytes ? imageMime(bytes) : null;
        return bytes && mime ? { bytes, mime } : null;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }
}

let shared: FaviconCache | null = null;
export function favicons(): FaviconCache {
  shared ??= new FaviconCache();
  return shared;
}
