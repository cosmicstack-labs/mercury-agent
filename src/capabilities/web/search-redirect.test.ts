import { describe, expect, it, vi } from 'vitest';

const PARALLEL_REPLY = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { results: [
  { url: 'https://www.theverge.com/ai', title: 'Latest AI news - The Verge', excerpts: ['All the AI news.'] },
  { url: 'https://www.reuters.com/technology/ai', title: 'AI News | Reuters', excerpts: ['AI news today.'] },
  { url: 'https://www.technologyreview.com/ai', title: 'AI - MIT Technology Review', excerpts: ['AI news today.'] },
  { url: 'https://techcrunch.com/ai', title: 'AI news | TechCrunch', excerpts: ['AI news today.'] },
] } } });

vi.mock('../../utils/ssrf.js', () => ({
  guardedFetch: vi.fn(async (url: string) => {
    if (url.includes('duckduckgo.com')) return new Response('<html>anomaly challenge</html>', { status: 202 });
    return new Response('<html><body><p>An article</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }),
}));

import { createFetchUrlTool } from './fetch-url.js';

// Parallel, the first search engine, uses the global fetch: it answers here.
vi.stubGlobal('fetch', vi.fn(async () => new Response(PARALLEL_REPLY, { status: 200 })));
import { guardedFetch } from '../../utils/ssrf.js';
import { isBrokenSearchSkill } from '../../skills/loader.js';

/**
 * Old web-search skills tell the model to fetch DuckDuckGo's HTML page, which
 * answers bots with a 202 challenge — so search "sometimes did not work".
 */
describe('fetch_url on a search results page', () => {
  it('answers with web_search results instead of the bot challenge page', async () => {
    const t = createFetchUrlTool() as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    const out = await t.execute({ url: 'https://html.duckduckgo.com/html/?q=latest+AI+news' }, {});
    expect(out).toMatch(/^Web results from Parallel for "latest AI news":/);
    expect(out).toContain('1. Latest AI news - The Verge');
    expect(out).toContain('Call web_search directly next time');
    const urls = vi.mocked(guardedFetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('duckduckgo.com'))).toBe(false);
  });

  it('fetches an ordinary page as before', async () => {
    const t = createFetchUrlTool() as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    expect(await t.execute({ url: 'https://example.com/post' }, {})).toContain('An article');
  });
});

describe('replacing a web-search skill that scrapes a blocked page', () => {
  it('flags a DuckDuckGo-scraping skill, never one that uses web_search or another skill dir', () => {
    const ddg = '---\nname: web-search\n---\nUse fetch_url on https://html.duckduckgo.com/html/?q=QUERY';
    expect(isBrokenSearchSkill('web-search', ddg)).toBe(true);
    expect(isBrokenSearchSkill('web-search', 'Use fetch_url on https://www.google.com/search?q=QUERY')).toBe(true);
    expect(isBrokenSearchSkill('web-search', ddg + '\nPrefer the web_search tool.')).toBe(false);
    expect(isBrokenSearchSkill('my-search', ddg)).toBe(false);
    expect(isBrokenSearchSkill('web-search', 'Search with Tavily using TAVILY_API_KEY')).toBe(false);
  });
});

describe('the installed web-search skill on upgrade', () => {
  it('a DuckDuckGo-scraping copy is replaced by the built-in one and kept as a backup; an edited working one is left alone', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SkillLoader } = await import('../../skills/loader.js');
    const dir = mkdtempSync(join(tmpdir(), 'mercury-search-skill-'));
    try {
      const ddg = '---\nname: web-search\ndescription: Search the web using DuckDuckGo.\n---\n\n1. Use `fetch_url` on https://html.duckduckgo.com/html/?q=QUERY\n';
      mkdirSync(join(dir, 'web-search'), { recursive: true });
      writeFileSync(join(dir, 'web-search', 'SKILL.md'), ddg);
      new SkillLoader(dir).discover();
      const now = readFileSync(join(dir, 'web-search', 'SKILL.md'), 'utf-8');
      expect(now).toContain('Call web_search with a focused query');
      expect(readFileSync(join(dir, 'web-search', 'SKILL.md.replaced.bak'), 'utf-8')).toBe(ddg);

      const mine = '---\nname: web-search\n---\nUse web_search, then summarise in Urdu.\n';
      writeFileSync(join(dir, 'web-search', 'SKILL.md'), mine);
      rmSync(join(dir, 'web-search', 'SKILL.md.replaced.bak'));
      new SkillLoader(dir).discover();
      expect(readFileSync(join(dir, 'web-search', 'SKILL.md'), 'utf-8')).toBe(mine);
      expect(existsSync(join(dir, 'web-search', 'SKILL.md.replaced.bak'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
