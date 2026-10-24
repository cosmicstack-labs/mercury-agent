import { afterEach, describe, expect, it, vi } from 'vitest';

const GOOGLE_NEWS = `<?xml version="1.0"?><rss><channel><title>Google News</title>
<item><title>Envoy meets leader in Moscow - BBC</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Wed, 21 Oct 2026 08:00:00 GMT</pubDate><description>&lt;a href="x"&gt;Envoy meets leader&lt;/a&gt;&amp;nbsp;BBC</description><source url="https://www.bbc.co.uk">BBC</source></item>
<item><title>Markets rally - Reuters</title><link>https://news.google.com/rss/articles/def</link><pubDate>Wed, 21 Oct 2026 07:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
</channel></rss>`;

const BING = `<?xml version="1.0"?><rss><channel>
<item><title>what is the capital of australia - Bing</title><link>http://www.bing.com:80/search?q=x</link></item>
<item><title>Canberra - Wikipedia</title><link>https://en.wikipedia.org/wiki/Canberra</link><description>Canberra is the capital city of Australia.</description></item>
</channel></rss>`;

/** What Bing's web RSS answers automated requests with today: pages unrelated to the query. */
const BING_JUNK = `<?xml version="1.0"?><rss><channel>
<item><title>SonyLIV Coupons, Promo Code &amp; Subscription Offers</title><link>https://example.com/sonyliv</link><description>Save on SonyLIV.</description></item>
<item><title>Jammu to Chandigarh Trains - redBus</title><link>https://example.com/trains</link><description>Train timings.</description></item>
</channel></rss>`;

/** Two results trimmed from a real Brave Search page (markup as served in October 2026). */
const BRAVE = `<!doctype html><html><body><div class="snippet">
<a href="https://search.brave.com/settings" class="nav">Settings</a>
<a href="https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html" target="_self" class="svelte-14r20fy l1"><div class="site-name-wrapper"><cite class="snippet-url">typescriptlang.org</cite></div> <div class="title search-snippet-title line-clamp-1 svelte-14r20fy" title="TypeScript: Documentation - TypeScript 4.9">TypeScript: Documentation - TypeScript 4.9</div></a><!----> <div class="generic-snippet svelte-1cwdgg3"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><!---->The new satisfies operator <strong>lets us validate that the type of an expression matches some type</strong>.<!----></div></div>
<a href="https://stackoverflow.com/questions/75000000/satisfies-vs-as" target="_self" class="svelte-14r20fy l1"><div class="title search-snippet-title line-clamp-1 svelte-14r20fy" title="What are the differences between TypeScript&#39;s satisfies operator and type assertions? - Stack Overflow">x</div></a><div class="generic-snippet"><div class="content desktop-default-regular">satisfies checks without widening; as asserts.</div></div>
</div></body></html>`;

const WIKI = JSON.stringify({ query: { search: [
  { title: 'Canberra', snippet: '<span class="searchmatch">Canberra</span> is the capital city of Australia.', timestamp: '2026-10-01T00:00:00Z' },
  { title: 'Australian Capital Territory', snippet: 'A federal territory around Canberra, the capital of Australia', timestamp: '2026-09-01T00:00:00Z' },
] } });

const HN = JSON.stringify({ hits: [
  { title: "TypeScript's satisfies operator", url: 'https://example.dev/satisfies', objectID: '41', points: 120, created_at: '2026-10-02T00:00:00Z' },
  { title: 'Ask HN: TypeScript satisfies vs as?', url: null, objectID: '42', points: 30 },
] });

const routes = (map: Record<string, string | number>) => async (url: string) => {
  for (const [host, body] of Object.entries(map)) {
    if (url.includes(host)) return typeof body === 'number' ? new Response('', { status: body }) : new Response(body, { status: 200 });
  }
  return new Response('', { status: 404 });
};

const defaultFetch = routes({ 'search.brave.com': BRAVE, 'news.google.com': GOOGLE_NEWS, 'bing.com/news': GOOGLE_NEWS, 'bing.com': BING, 'wikipedia.org': WIKI, 'hn.algolia.com': HN });

vi.mock('../../utils/ssrf.js', () => ({ guardedFetch: vi.fn() }));

import { createWebSearchTool, directLink, parseBrave, parseDdg, parseRss, relevant, resetBraveCooldown, searchQueryFromUrl, webSearch } from './web-search.js';
import { guardedFetch } from '../../utils/ssrf.js';

vi.mocked(guardedFetch).mockImplementation(defaultFetch as never);
// Tests that swap the fetch mock must not leak it (or a Brave cooldown) into the next test.
afterEach(() => { vi.mocked(guardedFetch).mockClear(); vi.mocked(guardedFetch).mockImplementation(defaultFetch as never); resetBraveCooldown(); });

describe('web_search', () => {
  it('parses Google News items, strips the source suffix, keeps the date', () => {
    const r = parseRss(GOOGLE_NEWS, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Envoy meets leader in Moscow', source: 'BBC', date: 'Wed, 21 Oct 2026 08:00:00 GMT' });
    expect(r[0].snippet).toBe('Envoy meets leader BBC');
  });

  it('drops Bing\'s self-link item', () => {
    expect(parseRss(BING, 5).map((x) => x.url)).toEqual(['https://en.wikipedia.org/wiki/Canberra']);
  });

  it('parses Brave results: link, title, snippet; skips Brave\'s own links', () => {
    const r = parseBrave(BRAVE, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: 'TypeScript: Documentation - TypeScript 4.9',
      url: 'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html',
      snippet: 'The new satisfies operator lets us validate that the type of an expression matches some type .',
    });
    expect(r[1].title).toBe("What are the differences between TypeScript's satisfies operator and type assertions? - Stack Overflow");
    expect(r[1].snippet).toBe('satisfies checks without widening; as asserts.');
  });

  it('web uses Brave first; news uses Google News; all through the SSRF guard', async () => {
    const web = await webSearch('typescript satisfies operator');
    expect(web.engine).toMatch(/^Brave/); // two hits here, so Wikipedia tops it up
    expect(web.results[0].url).toContain('typescriptlang.org');
    expect(String(vi.mocked(guardedFetch).mock.calls[0][0])).toMatch(/^https:\/\/search\.brave\.com\/search\?q=typescript%20satisfies%20operator/);
    expect((await webSearch('', { kind: 'news' })).engine).toBe('Google News');
  });

  it('an engine answering with unrelated pages counts as empty: Bing\'s junk never reaches the model', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': 503, 'wikipedia.org': 503, 'hn.algolia.com': 503, 'news.google.com': 503, 'bing.com/news': 503, 'bing.com': BING_JUNK }) as never);
    await expect(webSearch('typescript satisfies operator')).rejects.toThrow(/Bing: only unrelated results/);
  });

  it('relevance: one or two words must all appear, longer queries need half', () => {
    const r = (title: string) => ({ title, url: 'https://x.dev', snippet: '' });
    expect(relevant('best pizza in srinagar', [r('Best pizza places in Srinagar'), r('Srinagar war history'), r('Pizza in Rome')]).map((x) => x.title)).toEqual(['Best pizza places in Srinagar']);
    expect(relevant('typescript satisfies operator', [r('The satisfies operator'), r('TypeScript handbook'), r('Train timings')]).map((x) => x.title)).toEqual(['The satisfies operator']);
    expect(relevant('', [r('anything')])).toHaveLength(1);
  });

  it('keeps going down the keyless chain: Wikipedia, then Hacker News', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': 429, 'wikipedia.org': WIKI, 'hn.algolia.com': HN }) as never);
    const wiki = await webSearch('canberra');
    expect(wiki.engine).toBe('Wikipedia');
    expect(wiki.results[0]).toMatchObject({ title: 'Canberra', url: 'https://en.wikipedia.org/wiki/Canberra', snippet: 'Canberra is the capital city of Australia.', source: 'Wikipedia' });

    resetBraveCooldown();
    vi.mocked(guardedFetch).mockImplementation(routes({ 'hn.algolia.com': HN }) as never);
    const hn = await webSearch('typescript satisfies');
    expect(hn.engine).toBe('Hacker News');
    expect(hn.results[0]).toMatchObject({ title: "TypeScript's satisfies operator", url: 'https://example.dev/satisfies', source: 'Hacker News' });
    // A story without its own link points at the discussion.
    expect(hn.results[1].url).toBe('https://news.ycombinator.com/item?id=42');
  });

  it('after a 429, Brave rests for a minute instead of being tried on every query', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': 429, 'wikipedia.org': WIKI }) as never);
    await webSearch('canberra');
    await webSearch('canberra capital');
    const braveCalls = vi.mocked(guardedFetch).mock.calls.filter((c) => String(c[0]).includes('search.brave.com'));
    expect(braveCalls).toHaveLength(1);
  });

  it('tops a thin answer up with Wikipedia and lists each page once', async () => {
    const oneHit = `<a href="https://en.wikipedia.org/wiki/Canberra" target="_self" class="l1"><div class="title search-snippet-title" title="Canberra, capital of Australia">x</div></a><div class="content">The capital of Australia.</div>`;
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': oneHit, 'wikipedia.org': WIKI }) as never);
    const r = await webSearch('canberra australia');
    expect(r.engine).toBe('Brave + Wikipedia');
    expect(r.results.filter((x) => /wiki\/Canberra$/.test(x.url))).toHaveLength(1);
    expect(r.results.map((x) => x.title)).toContain('Australian Capital Territory');
  });

  it('recognises search-engine result URLs, so fetch_url can answer them with real results', () => {
    expect(searchQueryFromUrl('https://html.duckduckgo.com/html/?q=latest+AI+news')).toBe('latest AI news');
    expect(searchQueryFromUrl('https://lite.duckduckgo.com/lite/?q=x')).toBe('x');
    expect(searchQueryFromUrl('https://duckduckgo.com/?q=pandoc%20epub')).toBe('pandoc epub');
    expect(searchQueryFromUrl('https://www.google.com/search?q=canberra')).toBe('canberra');
    expect(searchQueryFromUrl('https://www.google.co.uk/search?q=canberra')).toBe('canberra');
    expect(searchQueryFromUrl('https://www.bing.com/search?q=canberra')).toBe('canberra');
    expect(searchQueryFromUrl('https://search.yahoo.com/search?p=canberra')).toBe('canberra');
    // Not search pages: the feed web_search itself uses, articles, empty queries.
    expect(searchQueryFromUrl('https://www.bing.com/search?q=canberra&format=rss')).toBeNull();
    expect(searchQueryFromUrl('https://duckduckgo.com/about')).toBeNull();
    expect(searchQueryFromUrl('https://en.wikipedia.org/wiki/Canberra')).toBeNull();
    expect(searchQueryFromUrl('https://html.duckduckgo.com/html/')).toBeNull();
    expect(searchQueryFromUrl('not a url')).toBeNull();
  });

  it('the tool returns a readable list, or a clear error', async () => {
    const t = createWebSearchTool() as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    const out = await t.execute({ query: '', kind: 'news' }, {});
    expect(out).toMatch(/News results from Google News[\s\S]*1\. Envoy meets leader in Moscow \(BBC · Wed, 21 Oct 2026\)/);
    vi.mocked(guardedFetch).mockImplementation(async () => new Response('', { status: 500 }));
    expect(await t.execute({ query: 'x' }, {})).toMatch(/^Error: web search found nothing: no source found anything \(Brave: HTTP 500; DuckDuckGo: HTTP 500/);
  });

  it('parses DuckDuckGo html and lite pages: real links out of the redirect, ads dropped', () => {
    const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpandoc.org%2Fepub.html&amp;rut=abc">Pandoc - Creating an ebook with pandoc</a>
      <a class="result__snippet" href="x">Starting with version 1.6, <b>pandoc</b> can produce EPUB.</a>
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1">Sponsored</a>`;
    expect(parseDdg(html, 5)).toEqual([{ title: 'Pandoc - Creating an ebook with pandoc', url: 'https://pandoc.org/epub.html', snippet: 'Starting with version 1.6, pandoc can produce EPUB.' }]);
    const lite = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fcosmic-stack&amp;rut=x" class='result-link'>Cosmic Stack - LinkedIn</a>
      <td class='result-snippet'>Cosmic Stack builds Mercury.</td>`;
    expect(parseDdg(lite, 5)[0]).toEqual({ title: 'Cosmic Stack - LinkedIn', url: 'https://www.linkedin.com/company/cosmic-stack', snippet: 'Cosmic Stack builds Mercury.' });
  });

  it('news links open the article: Bing News redirects are unwrapped', () => {
    expect(directLink('http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=1&url=https%3a%2f%2fkashmirlife.net%2fstory&c=2')).toBe('https://kashmirlife.net/story');
    expect(directLink('https://kashmirlife.net/story')).toBe('https://kashmirlife.net/story');
    const feed = `<rss><channel><item><title>Kashmir story</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fkashmirlife.net%2fstory</link></item></channel></rss>`;
    expect(parseRss(feed, 3)[0].url).toBe('https://kashmirlife.net/story');
  });

  it('news asks Bing News first, so links are direct; Google News is the fallback', async () => {
    const bingNewsFeed = `<rss><channel><item><title>Kashmir story</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fkashmirlife.net%2fstory</link></item></channel></rss>`;
    vi.mocked(guardedFetch).mockImplementation(routes({ 'bing.com/news': bingNewsFeed, 'news.google.com': GOOGLE_NEWS }) as never);
    const r = await webSearch('kashmir', { kind: 'news' });
    expect(r.engine).toBe('Bing News');
    expect(r.results[0].url).toBe('https://kashmirlife.net/story');
  });

  it('combines engines until there are enough results, and records what each one did', async () => {
    const oneHit = `<a href="https://www.typescriptlang.org/satisfies" target="_self" class="l1"><div class="title search-snippet-title" title="TypeScript satisfies operator">x</div></a><div class="content">satisfies</div>`;
    const ddgPage = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.dev%2Fa">TypeScript satisfies explained</a><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.dev%2Fb">The satisfies operator in TypeScript</a><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.dev%2Fc">TypeScript satisfies vs as</a>`;
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': oneHit, 'html.duckduckgo.com': ddgPage }) as never);
    const r = await webSearch('typescript satisfies operator', { max: 8 });
    expect(r.engine).toBe('Brave + DuckDuckGo');
    expect(r.results).toHaveLength(4);
    expect(r.trail).toEqual(['Brave: 1 result', 'DuckDuckGo: 3 results']);
  });

  it('a bot challenge reads as "blocked" in the trail', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': 429, 'duckduckgo.com': '<html>anomaly</html>', 'wikipedia.org': WIKI }) as never);
    const r = await webSearch('canberra');
    expect(r.trail.slice(0, 4)).toEqual(['Brave: blocked (HTTP 429)', 'DuckDuckGo: blocked (bot challenge)', 'DuckDuckGo Lite: blocked (bot challenge)', 'Wikipedia: 2 results']);
  });

  it('when the web indexes are blocked, the owner\'s own provider search answers (Anthropic first)', async () => {
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': 429, 'wikipedia.org': WIKI }) as never);
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('anthropic')) return new Response(JSON.stringify({ content: [
        { type: 'web_search_tool_result', content: [
          { type: 'web_search_result', title: 'Dario Amodei', url: 'https://darioamodei.com/', page_age: 'October 2026' },
          { type: 'web_search_result', title: 'Anthropic leadership', url: 'https://www.anthropic.com/company' },
        ] },
        { type: 'text', text: 'Dario Amodei is the CEO.', citations: [{ url: 'https://darioamodei.com/', cited_text: 'Dario Amodei, CEO of Anthropic' }] },
      ] }), { status: 200 });
      return new Response('no', { status: 500 });
    }) as typeof fetch;
    try {
      const r = await webSearch('canberra', { providers: [{ name: 'anthropic', apiKey: 'sk-ant-test-key', baseUrl: 'https://api.anthropic.com' }, { name: 'openai', apiKey: 'sk-test-key-openai', baseUrl: 'https://api.openai.com/v1' }] });
      expect(r.engine).toBe('Anthropic web search + Wikipedia');
      expect(r.results[0]).toMatchObject({ title: 'Dario Amodei', url: 'https://darioamodei.com/', snippet: 'Dario Amodei, CEO of Anthropic' });
      expect(r.trail.at(-1)).toBe('Anthropic web search: 2 results');
      expect(calls).toEqual(['https://api.anthropic.com/v1/messages']); // OpenAI not needed
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a strong free answer never touches the paid provider search', async () => {
    const page = Array.from({ length: 5 }, (_, i) => `<a href="https://example.dev/${i}" target="_self" class="l1"><div class="title search-snippet-title" title="Canberra page ${i}">x</div></a>`).join('');
    vi.mocked(guardedFetch).mockImplementation(routes({ 'search.brave.com': page }) as never);
    const realFetch = globalThis.fetch;
    let paid = 0;
    globalThis.fetch = (async () => { paid++; return new Response('{}'); }) as typeof fetch;
    try {
      const r = await webSearch('canberra', { providers: [{ name: 'anthropic', apiKey: 'sk-ant-test-key', baseUrl: '' }] });
      expect(r.engine).toBe('Brave');
      expect(paid).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
