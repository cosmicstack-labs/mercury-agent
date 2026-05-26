import { tool, zodSchema } from 'ai';
import { z } from 'zod';

const MAX_CONTENT_LENGTH = 15000;

function stripHtml(html: string): string {
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
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]');
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

export function createFetchUrlTool() {
  return tool({
    description: 'Fetch a URL and return its content as text. Strips HTML to readable markdown-like format. Useful for reading documentation, APIs, or web pages.',
    inputSchema: zodSchema(z.object({
      url: z.string().describe('The URL to fetch'),
      format: z.enum(['text', 'markdown']).optional().describe('Output format (default: markdown)'),
    })),
    execute: async ({ url, format }) => {
      const outputFormat = format ?? 'markdown';

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
          const text = stripHtml(body);
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