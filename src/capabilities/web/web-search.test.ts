import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Real pages, saved from html.duckduckgo.com and lite.duckduckgo.com for "pandoc epub to markdown". */
const DDG_HTML_PAGE = readFileSync(join(__dirname, 'fixtures', 'ddg-html.html'), 'utf8');
const DDG_LITE_PAGE = readFileSync(join(__dirname, 'fixtures', 'ddg-lite.html'), 'utf8');

const GOOGLE_NEWS = `<?xml version="1.0"?><rss><channel><title>Google News</title>
<item><title>Envoy meets leader in Moscow - BBC</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Wed, 21 Oct 2026 08:00:00 GMT</pubDate><description>&lt;a href="x"&gt;Envoy meets leader&lt;/a&gt;&amp;nbsp;BBC</description><source url="https://www.bbc.co.uk">BBC</source></item>
<item><title>Markets rally - Reuters</title><link>https://news.google.com/rss/articles/def</link><pubDate>Wed, 21 Oct 2026 07:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
</channel></rss>`;

const routes = (map: Record<string, string | number>) => async (url: string) => {
  for (const [host, body] of Object.entries(map)) {
    if (!url.includes(host)) continue;
    return typeof body === 'number' ? new Response('', { status: body }) : new Response(body, { status: 200 });
  }
  return new Response('', { status: 404 });
};

const defaultFetch = routes({ 'news.google.com': GOOGLE_NEWS });

vi.mock('../../utils/ssrf.js', () => ({ guardedFetch: vi.fn() }));

import { createWebSearchTool, ddgTarget, directLink, looksLikeArticle, parseDdg, parseDdgHtml, parseDdgLite, parseParallel, parseRss, relevant, searchQueryFromUrl, webSearch } from './web-search.js';
import { guardedFetch } from '../../utils/ssrf.js';

vi.mocked(guardedFetch).mockImplementation(defaultFetch as never);

// Parallel (the first engine) is called with the global fetch. By default it
// is unavailable here, so tests reach DuckDuckGo; Parallel tests answer it.
const parallelDown = async () => new Response('', { status: 503 });
const fetchMock = vi.fn(parallelDown);
vi.stubGlobal('fetch', fetchMock);
const parallelReply = (results: unknown[]) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { search_id: 's', results } } }), { status: 200 });

afterEach(() => {
  vi.mocked(guardedFetch).mockClear();
  vi.mocked(guardedFetch).mockImplementation(defaultFetch as never);
  fetchMock.mockReset();
  fetchMock.mockImplementation(parallelDown);
});

const ddgHtmlHit = (target: string, title: string, snippet: string, cls = 'result results_links results_links_deep web-result ') =>
  `<div class="${cls}"><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc">${title}</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}">${snippet}</a></div></div>`;

describe('DuckDuckGo parsing (exact markup)', () => {
  it('reads all ten results from a real html page: titles, real links, snippets', () => {
    const r = parseDdgHtml(DDG_HTML_PAGE, 20);
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual({
      title: 'Convert epub to markdown : r/pandoc - Reddit',
      url: 'https://www.reddit.com/r/pandoc/comments/sg6sqx/convert_epub_to_markdown/',
      snippet: expect.stringMatching(/^Hi, I want to convert an ebook in epub format to markdown/),
    });
    expect(r.map((x) => x.url)).toContain('https://pandoc.org/epub.html');
    for (const x of r) {
      expect(x.url).toMatch(/^https:\/\//);
      expect(x.url).not.toMatch(/duckduckgo\.com/);
      expect(x.title).not.toMatch(/<|&amp;/);
    }
  });

  it('reads all ten results from a real lite page, the same pages as the html one', () => {
    const r = parseDdgLite(DDG_LITE_PAGE, 20);
    expect(r).toHaveLength(10);
    expect(r[0].url).toBe('https://www.reddit.com/r/pandoc/comments/sg6sqx/convert_epub_to_markdown/');
    expect(r[0].snippet).toMatch(/^Hi, I want to convert an ebook in epub format to markdown/);
    expect(new Set(r.map((x) => x.url))).toEqual(new Set(parseDdgHtml(DDG_HTML_PAGE, 20).map((x) => x.url)));
  });

  it('parseDdg picks the right parser for either page', () => {
    expect(parseDdg(DDG_HTML_PAGE, 3)).toEqual(parseDdgHtml(DDG_HTML_PAGE, 3));
    expect(parseDdg(DDG_LITE_PAGE, 3)).toEqual(parseDdgLite(DDG_LITE_PAGE, 3));
  });

  it('drops ads on both pages', () => {
    const ad = `<div class="result results_links results_links_deep result--ad "><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;u3=x">Buy now</a></h2><a class="result__snippet" href="https://duckduckgo.com/y.js?x">Sponsored</a></div>`;
    const html = ad + ddgHtmlHit('https://pandoc.org/epub.html', 'Pandoc EPUB', 'Creating an ebook with pandoc');
    expect(parseDdgHtml(html, 5).map((x) => x.url)).toEqual(['https://pandoc.org/epub.html']);
    const lite = `<table><tr class="result-sponsored"><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>Ad</a></td></tr>
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpandoc.org%2Fepub.html&amp;rut=x" class='result-link'>Pandoc EPUB</a></td></tr>
      <tr><td class='result-snippet'>Creating an ebook with <b>pandoc</b>.</td></tr></table>`;
    expect(parseDdgLite(lite, 5)).toEqual([{ title: 'Pandoc EPUB', url: 'https://pandoc.org/epub.html', snippet: 'Creating an ebook with pandoc .' }]);
  });

  it('unwraps the redirect, keeps direct links, and rejects DuckDuckGo\'s own pages', () => {
    expect(ddgTarget('//duckduckgo.com/l/?uddg=https%3A%2F%2Fpandoc.org%2Fepub.html&amp;rut=abc')).toBe('https://pandoc.org/epub.html');
    expect(ddgTarget('https://example.dev/page')).toBe('https://example.dev/page');
    expect(ddgTarget('https://duckduckgo.com/y.js?ad_domain=x')).toBeNull();
    expect(ddgTarget('//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fsettings')).toBeNull();
    expect(ddgTarget('/html/?q=next')).toBeNull();
    expect(ddgTarget('javascript:void(0)')).toBeNull();
  });
});

describe('web_search chain: Parallel, then DuckDuckGo html, then lite', () => {
  it('Parallel answers first: one keyless MCP tools/call, results with excerpts and dates', async () => {
    fetchMock.mockImplementation(async () => parallelReply([
      { url: 'https://www.linkedin.com/company/cosmic-stack', title: 'Cosmic Stack', publish_date: '2026-05-14', excerpts: ['* Name: Cosmic Stack\n * description\n - Cosmic Stack is a technology company focused on agentic AI, building [Mercury Agent](https://mercuryagent.sh).'] },
      { url: 'https://cosmicstack.ai', title: 'Cosmic Stack', publish_date: null, excerpts: ['Cosmic Stack builds open agentic AI.'] },
      { url: 'https://github.com/cosmicstack-labs', title: 'Cosmic Stack Labs', excerpts: [] },
      { url: 'https://x.com/cosmicstack', title: 'Cosmic Stack on X', excerpts: ['Cosmic Stack news'] },
    ]));
    const r = await webSearch('cosmic stack linkedin');
    expect(r.engine).toBe('Parallel');
    expect(r.trail).toEqual(['Parallel: 4 results']);
    expect(r.results[0]).toEqual({ title: 'Cosmic Stack', url: 'https://www.linkedin.com/company/cosmic-stack', date: '2026-05-14', snippet: 'Name: Cosmic Stack description - Cosmic Stack is a technology company focused on agentic AI, building Mercury Agent.' });
    expect(vi.mocked(guardedFetch)).not.toHaveBeenCalled(); // Parallel had enough
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://search.parallel.ai/mcp');
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'web_search', arguments: { objective: 'cosmic stack linkedin', search_queries: ['cosmic stack linkedin'] } } });
  });

  it('Parallel down: DuckDuckGo\'s html page answers', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'html.duckduckgo.com': DDG_HTML_PAGE }) as never);
    const r = await webSearch('pandoc epub to markdown');
    expect(r.engine).toBe('DuckDuckGo');
    expect(r.trail[0]).toBe('Parallel: HTTP 503');
    expect(r.trail[1]).toMatch(/^DuckDuckGo: \d+ results$/);
    expect(r.results[0].url).toBe('https://www.reddit.com/r/pandoc/comments/sg6sqx/convert_epub_to_markdown/');
    expect(String(vi.mocked(guardedFetch).mock.calls[0][0])).toBe('https://html.duckduckgo.com/html/?q=pandoc%20epub%20to%20markdown');
  });

  it('a challenged html page is retried once, then the lite page answers', async () => {
    let htmlCalls = 0;
    vi.mocked(guardedFetch).mockImplementation((async (url: string) => {
      if (url.includes('html.duckduckgo.com')) { htmlCalls++; return new Response('<html>anomaly</html>', { status: 202 }); }
      if (url.includes('lite.duckduckgo.com')) return new Response(DDG_LITE_PAGE, { status: 200 });
      return new Response('', { status: 404 });
    }) as never);
    const r = await webSearch('pandoc epub to markdown');
    expect(htmlCalls).toBe(2);
    expect(r.engine).toBe('DuckDuckGo Lite');
    expect(r.trail.slice(0, 2)).toEqual(['Parallel: HTTP 503', 'DuckDuckGo: blocked (bot challenge)']);
    expect(r.trail[2]).toMatch(/^DuckDuckGo Lite: \d+ results$/);
  });

  it('a challenge then a normal page counts as a success', async () => {
    let calls = 0;
    vi.mocked(guardedFetch).mockImplementation((async (url: string) => {
      if (url.includes('html.duckduckgo.com')) return ++calls === 1 ? new Response('<html>anomaly</html>', { status: 202 }) : new Response(DDG_HTML_PAGE, { status: 200 });
      return new Response('', { status: 404 });
    }) as never);
    const r = await webSearch('pandoc epub');
    expect(calls).toBe(2);
    expect(r.engine).toBe('DuckDuckGo');
  });

  it('Parallel and DuckDuckGo are combined until there are enough results', async () => {
    fetchMock.mockImplementation(async () => parallelReply([{ url: 'https://pandoc.org/MANUAL.html', title: 'Pandoc manual: EPUB to Markdown', excerpts: ['pandoc converts epub to markdown'] }]));
    vi.mocked(guardedFetch).mockImplementation(routes({ 'html.duckduckgo.com': DDG_HTML_PAGE }) as never);
    const r = await webSearch('pandoc epub to markdown');
    expect(r.engine).toBe('Parallel + DuckDuckGo');
    expect(r.results[0].url).toBe('https://pandoc.org/MANUAL.html');
    expect(r.trail[0]).toBe('Parallel: 1 result');
  });

  it('a real "no results" page is no results; an unrecognised page says so', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'html.duckduckgo.com': '<html><div class="no-results">No results.</div></html>', 'lite.duckduckgo.com': '<html><body>something new</body></html>' }) as never);
    await expect(webSearch('zzqqxx unfindable')).rejects.toThrow('no source found anything (Parallel: HTTP 503; DuckDuckGo: no results; DuckDuckGo Lite: page not recognised)');
  });

  it('only results that mention the query count', () => {
    const r = (title: string) => ({ title, url: 'https://x.dev', snippet: '' });
    expect(relevant('best pizza in srinagar', [r('Best pizza places in Srinagar'), r('Srinagar war history'), r('Pizza in Rome')]).map((x) => x.title)).toEqual(['Best pizza places in Srinagar']);
    expect(relevant('typescript satisfies operator', [r('The satisfies operator'), r('TypeScript handbook'), r('Train timings')]).map((x) => x.title)).toEqual(['The satisfies operator']);
    expect(relevant('', [r('anything')])).toHaveLength(1);
  });

  it('the tool returns a readable list with the trail, or a clear error', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'html.duckduckgo.com': DDG_HTML_PAGE }) as never);
    const t = createWebSearchTool() as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    const out = await t.execute({ query: 'pandoc epub' }, {});
    expect(out).toMatch(/^Web results from DuckDuckGo for "pandoc epub":\n\n1\. Convert epub to markdown : r\/pandoc - Reddit/);
    expect(out).toMatch(/Searched: Parallel: HTTP 503 → DuckDuckGo: \d+ results$/);
    vi.mocked(guardedFetch).mockImplementation(async () => new Response('', { status: 500 }));
    expect(await t.execute({ query: 'x' }, {})).toMatch(/^Error: web search found nothing: no source found anything \(Parallel: HTTP 503; DuckDuckGo: HTTP 500; DuckDuckGo Lite: HTTP 500\)/);
  });
});

describe('news', () => {
  it('parses Google News items, strips the source suffix, keeps the date', () => {
    const r = parseRss(GOOGLE_NEWS, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Envoy meets leader in Moscow', source: 'BBC', date: 'Wed, 21 Oct 2026 08:00:00 GMT' });
    expect(r[0].snippet).toBe('Envoy meets leader BBC');
  });

  it('Bing News redirects are unwrapped to the article', () => {
    expect(directLink('http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=1&url=https%3a%2f%2fkashmirlife.net%2fstory&c=2')).toBe('https://kashmirlife.net/story');
    expect(directLink('https://kashmirlife.net/story')).toBe('https://kashmirlife.net/story');
    const feed = `<rss><channel><item><title>Kashmir story</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fkashmirlife.net%2fstory</link></item></channel></rss>`;
    expect(parseRss(feed, 3)[0].url).toBe('https://kashmirlife.net/story');
  });

  it('Parallel keeps article links and drops section fronts; Bing News fills in', async () => {
    expect(looksLikeArticle('https://www.greaterkashmir.com/kashmir')).toBe(false);
    expect(looksLikeArticle('https://www.greaterkashmir.com/latest-news')).toBe(false);
    expect(looksLikeArticle('https://www.democracynow.org/2026/10/23/headlines')).toBe(true);
    expect(looksLikeArticle('https://kashmirlife.net/news/jammu-kashmir-government-warns-officers-over-delays')).toBe(true);
    expect(looksLikeArticle('https://www.greaterkashmir.com/kashmir/attacks-on-infrastructure-unacceptable-12742822')).toBe(true);
    fetchMock.mockImplementation(async () => parallelReply([
      { url: 'https://www.greaterkashmir.com/kashmir', title: 'Kashmir News: Live Breaking News' },
      { url: 'https://www.greaterkashmir.com/kashmir/power-shutdown-in-kashmir-announced-12742577', title: 'Kashmir power shutdown announced', publish_date: '2026-10-23' },
    ]));
    const bingNewsFeed = `<rss><channel><item><title>Kashmir story</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fkashmirlife.net%2fstory</link></item></channel></rss>`;
    vi.mocked(guardedFetch).mockImplementation(routes({ 'bing.com/news': bingNewsFeed }) as never);
    const r = await webSearch('kashmir', { kind: 'news' });
    expect(r.engine).toBe('Parallel + Bing News');
    expect(r.results.map((x) => x.url)).toEqual(['https://www.greaterkashmir.com/kashmir/power-shutdown-in-kashmir-announced-12742577', 'https://kashmirlife.net/story']);
  });

  it('top stories with no query come from Google News when Parallel is down', async () => {
    const r = await webSearch('', { kind: 'news' });
    expect(r.engine).toBe('Google News');
  });
});

describe('MCP reply parsing and search-page URLs', () => {
  it('parses Parallel replies sent as server-sent events, and surfaces MCP errors', () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { results: [{ url: 'https://nodejs.org/en/blog/release', title: 'Node.js releases' }] } } })}\n\n`;
    expect(parseParallel(sse, 5)).toEqual([{ title: 'Node.js releases', url: 'https://nodejs.org/en/blog/release', snippet: '', date: undefined }]);
    expect(() => parseParallel(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } }), 5)).toThrow('rate limited');
  });

  it('recognises search-engine result URLs, so fetch_url can answer them with real results', () => {
    expect(searchQueryFromUrl('https://html.duckduckgo.com/html/?q=latest+AI+news')).toBe('latest AI news');
    expect(searchQueryFromUrl('https://lite.duckduckgo.com/lite/?q=x')).toBe('x');
    expect(searchQueryFromUrl('https://duckduckgo.com/?q=pandoc%20epub')).toBe('pandoc epub');
    expect(searchQueryFromUrl('https://www.google.com/search?q=canberra')).toBe('canberra');
    expect(searchQueryFromUrl('https://www.bing.com/search?q=canberra')).toBe('canberra');
    expect(searchQueryFromUrl('https://www.bing.com/search?q=canberra&format=rss')).toBeNull();
    expect(searchQueryFromUrl('https://en.wikipedia.org/wiki/Canberra')).toBeNull();
    expect(searchQueryFromUrl('not a url')).toBeNull();
  });
});
