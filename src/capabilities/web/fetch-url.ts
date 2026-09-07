import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

const MAX_CONTENT_LENGTH = 15000;
/** Cap the raw download before truncation — a multi-GB response must not
 *  load fully into the heap just to be sliced afterward. */
const MAX_DOWNLOAD_BYTES = 512 * 1024;

/**
 * SSRF guard: the model fetches web content at the request of whoever it is
 * talking to (or at the instruction of content it fetched earlier). Without
 * host validation, a page can steer Mercury into reading internal services —
 * localhost admin panels, LAN hosts, cloud metadata endpoints — and feed
 * their contents into the conversation. Private-range addresses are blocked
 * for both literal and DNS-resolved hosts, and every redirect hop is
 * re-validated (redirect: 'manual' — a public URL must not be able to hop
 * into a private one).
 */

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
async function assertFetchableTarget(rawUrl: string): Promise<URL> {
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

function resolveUrl(src: string, baseUrl: string): string {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

function extractSrcsetUrl(srcset: string): string | null {
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

function stripHtml(html: string, preserveImages = false, pageUrl = ''): string {
  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Only preserve images as markdown when research mode is active, so normal
  // fetches stay lean. Otherwise strip to a compact text placeholder.
  if (preserveImages) {
    text = text.replace(/<img[^>]*>/gi, (match) => {
      const getAttr = (name: string): string | null => {
        const m = match.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
        return m ? m[1] : null;
      };
      let src = getAttr('src') || getAttr('data-src') || getAttr('data-lazy-src') || '';
      if (!src) {
        const srcset = getAttr('srcset') || getAttr('data-srcset');
        if (srcset) {
          const extracted = extractSrcsetUrl(srcset);
          if (extracted) src = extracted;
        }
      }
      const alt = getAttr('alt') || '';
      if (!src || /1x1|pixel|spacer|blank/i.test(src)) return '';
      if (pageUrl) src = resolveUrl(src, pageUrl);
      return `\n\n![${alt}](${src})\n\n`;
    });
    text = text.replace(/<source[^>]*srcset="([^"]*)"[^>]*>/gi, (match, srcset: string) => {
      const src = extractSrcsetUrl(srcset);
      if (!src || /1x1|pixel|spacer|blank/i.test(src)) return '';
      const resolved = pageUrl ? resolveUrl(src, pageUrl) : src;
      return `\n\n![](${resolved})\n\n`;
    });
  } else {
    text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]');
    text = text.replace(/<img[^>]*>/gi, '');
  }
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');

  text = text.replace(/<[^>]+>/g, '');

  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

const MAX_REDIRECTS = 5;

/** Fetch with SSRF validation on the initial URL AND every redirect hop. */
async function guardedFetch(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertFetchableTarget(target);
    const resp = await fetch(validated, {
      signal,
      redirect: 'manual',
      headers: {
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

export function createFetchUrlTool(opts: { isResearchMode: () => boolean } = { isResearchMode: () => false }) {
  return tool({
    description: 'Fetch a URL and return its content as markdown. Private/internal network addresses are blocked (SSRF protection). In research mode, images from the page are preserved as ![alt](url) with absolute URLs so they can be embedded in research articles. Useful for reading documentation, news articles, APIs, or web pages.',
    inputSchema: zodSchema(z.object({
      url: z.string().describe('The URL to fetch (public http/https only)'),
      format: z.enum(['text', 'markdown']).optional().describe('Output format (default: markdown)'),
    })),
    execute: async ({ url, format }) => {
      const outputFormat = format ?? 'markdown';
      const preserveImages = opts.isResearchMode();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const resp = await guardedFetch(url, controller.signal);

        clearTimeout(timeout);

        if (!resp.ok) {
          return `HTTP ${resp.status} ${resp.statusText} for ${url}`;
        }

        const contentType = resp.headers.get('content-type') || '';
        const body = await resp.text();

        if (contentType.includes('application/json')) {
          try {
            const json = JSON.parse(body);
            const formatted = JSON.stringify(json, null, 2);
            return formatted.length > MAX_CONTENT_LENGTH
              ? formatted.slice(0, MAX_CONTENT_LENGTH) + '\n... (truncated)'
              : formatted;
          } catch {
            return body.slice(0, MAX_CONTENT_LENGTH);
          }
        }

        if (contentType.includes('text/html') && outputFormat === 'markdown') {
          const text = stripHtml(body, preserveImages, url);
          return text.length > MAX_CONTENT_LENGTH
            ? text.slice(0, MAX_CONTENT_LENGTH) + '\n... (truncated)'
            : text;
        }

        return body.length > MAX_CONTENT_LENGTH
          ? body.slice(0, MAX_CONTENT_LENGTH) + '\n... (truncated)'
          : body;
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return `Request to ${url} timed out after 30 seconds.`;
        }
        return `Error fetching ${url}: ${err.message}`;
      }
    },
  });
}