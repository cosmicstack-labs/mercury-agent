import { tool, zodSchema } from 'ai';
import { z } from 'zod';

const MAX_CONTENT_LENGTH = 15000;

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

export function createFetchUrlTool(opts: { isResearchMode: () => boolean } = { isResearchMode: () => false }) {
  return tool({
    description: 'Fetch a URL and return its content as markdown. In research mode, images from the page are preserved as ![alt](url) with absolute URLs so they can be embedded in research articles. Useful for reading documentation, news articles, APIs, or web pages.',
    inputSchema: zodSchema(z.object({
      url: z.string().describe('The URL to fetch'),
      format: z.enum(['text', 'markdown']).optional().describe('Output format (default: markdown)'),
    })),
    execute: async ({ url, format }) => {
      const outputFormat = format ?? 'markdown';
      const preserveImages = opts.isResearchMode();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const resp = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mercury-Agent/0.1.0',
            'Accept': 'text/html,application/json,text/plain',
          },
        });

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
