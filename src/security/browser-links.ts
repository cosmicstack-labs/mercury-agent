import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time sign-in links for a browser on the computer Mercury runs on
 * (`mercury web`, /web, Desktop's "Open in browser"). Mercury has no
 * password (ADR-050), so this is how the dashboard opens here. A link works
 * once, for 5 minutes, and only from this computer; only its hash is kept.
 */

export const BROWSER_LINK_TTL_MS = 5 * 60_000;
const MAX_LIVE = 5;

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export class BrowserLinks {
  private live: Array<{ hash: Buffer; expiresAt: number }> = [];

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = BROWSER_LINK_TTL_MS) {}

  /** A new code; the oldest live one goes when there are too many. */
  create(): { code: string; expiresAt: number } {
    this.prune();
    const code = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.live.push({ hash: sha(code), expiresAt });
    while (this.live.length > MAX_LIVE) this.live.shift();
    return { code, expiresAt };
  }

  /** True once per live code; the code is gone afterwards. */
  redeem(code: string): boolean {
    this.prune();
    if (!code || code.length > 100) return false;
    const presented = sha(code);
    const i = this.live.findIndex((l) => timingSafeEqual(l.hash, presented));
    if (i < 0) return false;
    this.live.splice(i, 1);
    return true;
  }

  private prune(): void {
    const t = this.now();
    this.live = this.live.filter((l) => l.expiresAt > t);
  }
}

let shared: BrowserLinks | null = null;

export function browserLinks(): BrowserLinks {
  shared ??= new BrowserLinks();
  return shared;
}

export function browserLinkUrl(port: number, code: string): string {
  return `http://localhost:${port}/login/once?c=${encodeURIComponent(code)}`;
}
