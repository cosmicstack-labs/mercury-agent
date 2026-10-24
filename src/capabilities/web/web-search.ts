import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { guardedFetch } from '../../utils/ssrf.js';

/**
 * web_search: free, keyless search for the model.
 *
 *   web  → Parallel (search.parallel.ai, keyless MCP), then DuckDuckGo's
 *           html page, then its lite page: the three keyless web indexes
 *           that answer automated requests
 *   news → Parallel, then Bing News (direct article links), Google News (its
 *           links are Google redirects), Hacker News
 *
 * Every answer must mention the query (relevant()); an engine serving junk
 * counts as empty and the next one is tried.
 *
 * Read-only and through the same SSRF guard as fetch_url. Returns titles,
 * links, snippets and dates; the model follows up with fetch_url to read a
 * page. Brave, Mojeek and Startpage refuse automated requests, and Bing's
 * web RSS serves unrelated pages, so none of them are used.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 12_000;

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function decode(s: string): string {
  // Feeds often carry escaped HTML inside a field (Google News descriptions):
  // unescape, strip tags, then unescape what was inside the markup.
  return unescape(unescape(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' '))
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  return m ? decode(m[1]) : '';
}

/**
 * The publisher's own URL behind a news-feed redirect. Bing News wraps every
 * article as bing.com/news/apiclick.aspx?…&url=<the article>; unwrap it so the
 * owner gets a link that opens the story. (Google News links can't be
 * unwrapped without running its JavaScript, which is why Bing News comes first.)
 */
export function directLink(link: string): string {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/.test(u.hostname) && /\/apiclick\.aspx$/i.test(u.pathname)) {
      const target = u.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch { /* not a URL: leave it */ }
  return link;
}

export function parseRss(xml: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const url = directLink(tag(item, 'link'));
    const title = tag(item, 'title');
    if (!url || !title || /bing\.com(:\d+)?\/search\?/.test(url)) continue;
    const source = tag(item, 'source');
    out.push({
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
      url,
      snippet: tag(item, 'description').slice(0, 300),
      source: source || undefined,
      date: tag(item, 'pubDate') || undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(url, ac.signal, { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Bing News RSS: relevant, recent, keyless. */
async function bingNews(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return parseRss(await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`), max);
}

/**
 * Parallel's public search over MCP (https://search.parallel.ai/mcp): a real
 * web index built for agents, keyless, answering in about a second with
 * excerpts and publish dates. Plain JSON-RPC over HTTP: one tools/call to
 * its web_search tool, no session needed. A fixed public HTTPS endpoint, so
 * it is called directly rather than through guardedFetch (GET-only).
 */
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';

interface ParallelHit { url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }

/** The MCP reply, as plain JSON or as a server-sent-events body. */
export function parseParallel(body: string, max: number): SearchResult[] {
  let text = body.trim();
  if (!text.startsWith('{')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    text = data[data.length - 1] ?? '';
  }
  const msg = JSON.parse(text) as { error?: { message?: string }; result?: { isError?: boolean; structuredContent?: { results?: ParallelHit[] }; content?: Array<{ type?: string; text?: string }> } };
  if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
  if (msg.result?.isError) throw new Error(msg.result.content?.[0]?.text?.slice(0, 160) ?? 'search error');
  let hits = msg.result?.structuredContent?.results;
  if (!hits) {
    const t = msg.result?.content?.find((c) => c.type === 'text')?.text;
    hits = t ? (JSON.parse(t) as { results?: ParallelHit[] }).results : undefined;
  }
  return (hits ?? []).filter((h) => h.url && /^https?:\/\//.test(h.url)).slice(0, max).map((h) => ({
    title: (h.title ?? h.url!).replace(/\s+/g, ' ').trim(),
    url: h.url!,
    // Excerpts are markdown cut from the page: flatten links and markup.
    snippet: (h.excerpts?.[0] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*>`_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    date: h.publish_date ?? undefined,
  }));
}

async function parallelSearch(objective: string, queries: string[], max: number): Promise<SearchResult[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(PARALLEL_MCP_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'User-Agent': 'Mercury-Agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { objective: objective.slice(0, 400), search_queries: queries } } }),
    });
    if (res.status === 429) throw new Error('rate-limited (HTTP 429)');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseParallel(await res.text(), max);
  } finally {
    clearTimeout(timer);
  }
}

/** Keyword queries for Parallel: the query itself, cut to its first eight words. */
function parallelQueries(query: string): string[] {
  return [query.replace(/["']/g, '').split(/\s+/).filter(Boolean).slice(0, 8).join(' ')];
}

async function parallel(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return parallelSearch(query, parallelQueries(query), max);
}

/**
 * A link to one story rather than a section front ("/kashmir", "/latest-news"):
 * a dated path, or at least two path segments with a long slug. News answers
 * should open the article.
 */
export function looksLikeArticle(url: string): boolean {
  let path: string;
  try { path = new URL(url).pathname; } catch { return false; }
  const parts = path.split('/').filter(Boolean);
  if (/\/(19|20)\d{2}\/\d{1,2}\//.test(path) || /\d{5,}/.test(path)) return true;
  const last = parts[parts.length - 1] ?? '';
  return parts.length >= 2 && (last.split('-').length >= 4 || last.length >= 30);
}

async function parallelNews(query: string, max: number): Promise<SearchResult[]> {
  const q = query.trim() || 'top news today';
  const hits = await parallelSearch(`Latest news articles about: ${q}. Prefer individual articles published in the last few days, from news sites.`, [...parallelQueries(q), `${parallelQueries(q)[0]} news`], max * 2);
  return hits.filter((h) => looksLikeArticle(h.url)).slice(0, max);
}

/**
 * DuckDuckGo's two no-JavaScript result pages, the keyless web index behind
 * Parallel. Both wrap every result link as
 * //duckduckgo.com/l/?uddg=<the page>&rut=…, and both mark ads: the html page
 * with a `result--ad` block linking to duckduckgo.com/y.js, the lite page
 * with a sponsored row. Parsed exactly from their markup:
 *
 *   html.duckduckgo.com/html/  <div class="result results_links …">
 *                                <a class="result__a" href=…>title</a>
 *                                <a class="result__snippet" href=…>snippet</a>
 *   lite.duckduckgo.com/lite/  <a class='result-link' href=…>title</a>
 *                              <td class='result-snippet'>snippet</td>
 *
 * DuckDuckGo answers some automated requests with a challenge (HTTP 202 or
 * an "anomaly" page). That, and a page with no results and no "No results"
 * notice (the markup changed), count as failures, so the trail says so.
 */

/** The page behind DuckDuckGo's redirect, or null for ads and DuckDuckGo's own links. */
export function ddgTarget(href: string): string | null {
  const raw = unescape(href.trim());
  let u: URL;
  try { u = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com'); } catch { return null; }
  const target = /(^|\.)duckduckgo\.com$/.test(u.hostname) ? u.searchParams.get('uddg') : u.href;
  if (!target || !/^https?:\/\//i.test(target)) return null;
  try {
    const t = new URL(target);
    return /(^|\.)duckduckgo\.com$/.test(t.hostname) ? null : t.href;
  } catch {
    return null;
  }
}

export function parseDdgHtml(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = [...html.matchAll(/<div class="(result\b[^"]*)"/g)].filter((m) => /\b(results_links|web-result)\b/.test(m[1]));
  for (let i = 0; i < blocks.length && out.length < max; i++) {
    if (/\bresult--ad\b/.test(blocks[i][1])) continue;
    const block = html.slice(blocks[i].index ?? 0, blocks[i + 1]?.index ?? html.length);
    const a = /<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const href = a && /href="([^"]*)"/.exec(a[0])?.[1];
    const url = href ? ddgTarget(href) : null;
    const title = a ? decode(a[1]) : '';
    if (!url || !title) continue;
    const snippet = /<(?:a|div)\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(block)?.[1] ?? '';
    out.push({ title, url, snippet: decode(snippet).slice(0, 300) });
  }
  return out;
}

export function parseDdgLite(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const links = [...html.matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < links.length && out.length < max; i++) {
    const at = links[i].index ?? 0;
    // A sponsored result sits in a row marked as such.
    if (/sponsored/i.test(html.slice(Math.max(0, html.lastIndexOf('<tr', at)), at))) continue;
    const href = /href=['"]([^'"]*)['"]/.exec(links[i][0])?.[1];
    const url = href ? ddgTarget(href) : null;
    const title = decode(links[i][1]);
    if (!url || !title) continue;
    const scope = html.slice(at, links[i + 1]?.index ?? html.length);
    const snippet = /<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(scope)?.[1] ?? '';
    out.push({ title, url, snippet: decode(snippet).slice(0, 300) });
  }
  return out;
}

/** Either page: the html page has result__a links, the lite page result-link. */
export function parseDdg(html: string, max: number): SearchResult[] {
  return /class="result__a"/.test(html) ? parseDdgHtml(html, max) : parseDdgLite(html, max);
}

const DDG_CHALLENGE = /anomaly|challenge-form|bots use DuckDuckGo too/i;
const DDG_NO_RESULTS = /No results\.|no-results|No more results/i;

async function ddgOnce(kind: 'html' | 'lite', query: string, max: number): Promise<SearchResult[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(`https://${kind}.duckduckgo.com/${kind}/?q=${encodeURIComponent(query)}`, ac.signal, {
      'User-Agent': UA,
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `https://${kind}.duckduckgo.com/`,
    });
    const body = await res.text();
    if (res.status === 202 || DDG_CHALLENGE.test(body)) throw new Error('bot challenge');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = kind === 'html' ? parseDdgHtml(body, max) : parseDdgLite(body, max);
    if (!results.length && !DDG_NO_RESULTS.test(body)) throw new Error('page not recognised');
    return results;
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo lets roughly every other automated request through: one retry after a short pause. */
const DDG_RETRY_MS = 1500;

async function ddg(kind: 'html' | 'lite', query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  try {
    return await ddgOnce(kind, query, max);
  } catch (err) {
    if (!/challenge/.test((err as Error).message)) throw err;
    await new Promise((r) => setTimeout(r, DDG_RETRY_MS));
    return ddgOnce(kind, query, max);
  }
}
const ddgHtml = (q: string, n: number) => ddg('html', q, n);
const ddgLite = (q: string, n: number) => ddg('lite', q, n);

async function googleNews(query: string, max: number): Promise<SearchResult[]> {
  const url = query.trim()
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  return parseRss(await fetchText(url), max);
}

async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url));
}

/** Hacker News via Algolia: keyless JSON, strong for software, startups and tech news. */
export async function hackerNews(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${Math.min(10, max)}`) as {
    hits?: Array<{ title?: string; url?: string | null; objectID: string; created_at?: string; points?: number }>;
  };
  return (data.hits ?? []).filter((h) => h.title).map((h) => ({
    title: h.title!,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: `Hacker News discussion · ${h.points ?? 0} points · https://news.ycombinator.com/item?id=${h.objectID}`,
    source: 'Hacker News',
    date: h.created_at,
  }));
}

/**
 * The search query behind a search-engine results URL, or null. Old skills
 * (and models from habit) fetch DuckDuckGo/Google/Bing result pages with
 * fetch_url; those answer bots with a challenge page or a wall of markup.
 * fetch_url hands such a URL to web_search instead.
 */
export function searchQueryFromUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const isSearch =
    (/^(html\.|lite\.)?duckduckgo\.com$/.test(host) && (u.pathname === '/' || /^\/(html|lite)\/?$/.test(u.pathname)))
    || (/^google\.[a-z.]+$/.test(host) && u.pathname === '/search')
    || (host === 'bing.com' && u.pathname === '/search' && u.searchParams.get('format') !== 'rss')
    || (host === 'search.yahoo.com' && u.pathname.startsWith('/search'))
    || (host === 'search.brave.com' && u.pathname === '/search')
    || (host === 'startpage.com' && u.pathname.startsWith('/do/search'))
    || (host === 'mojeek.com' && u.pathname === '/search');
  if (!isSearch) return null;
  const q = (u.searchParams.get('q') ?? u.searchParams.get('p') ?? u.searchParams.get('query') ?? '').trim();
  return q || null;
}

/** web_search output as text, for the tool and for fetch_url's search redirect. */
export function formatResults(results: SearchResult[], engine: string, query: string, kind: 'web' | 'news'): string {
  const lines = results.map((r, i) => {
    const meta = [r.source, r.date ? new Date(r.date).toUTCString().slice(0, 16) : ''].filter(Boolean).join(' · ');
    return `${i + 1}. ${r.title}${meta ? ` (${meta})` : ''}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`;
  });
  const viaGoogle = results.some((r) => /^https?:\/\/news\.google\.com\/rss\/articles\//.test(r.url));
  const note = viaGoogle ? '\n\nNote: news.google.com links are Google redirects, not the publisher\'s page. Say so if you share them, and name the source site.' : '';
  return `${kind === 'news' ? 'News' : 'Web'} results from ${engine} for "${query || 'top stories'}":\n\n${lines.join('\n')}${note}`;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'who', 'how', 'are', 'was', 'is', 'of', 'in', 'on', 'to', 'a', 'an', 'best', 'top', 'latest', 'new', 'news', 'does', 'did', 'can', 'from', 'about', 'near', 'me', 'my', 'vs']);

/**
 * Keep results that mention the query: every significant word when there are
 * one or two, at least half of them otherwise (title, snippet or URL). An
 * engine that answers with unrelated pages — Bing's web RSS does this to
 * automated requests — then counts as "no results" and the chain moves on
 * instead of handing the model junk. A query with no usable words (empty,
 * all stopwords) keeps everything.
 */
export function relevant(query: string, results: SearchResult[]): SearchResult[] {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))];
  if (terms.length === 0) return results;
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length / 2);
  return results.filter((r) => {
    const hay = `${r.title} ${r.snippet} ${decodeURIComponent(r.url.replace(/%(?![0-9a-f]{2})/gi, '%25'))}`.toLowerCase();
    return terms.filter((t) => hay.includes(t)).length >= need;
  });
}

/** Results that point at the same page (http/https, www, trailing slash, fragments) count once. */
function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface SearchOutcome {
  results: SearchResult[];
  /** The engines whose results are in the answer, e.g. "Parallel + DuckDuckGo". */
  engine: string;
  /** What each engine tried did: "Parallel: timed out", "DuckDuckGo: 6 results". */
  trail: string[];
}

/** Results needed before the search stops asking more engines. */
const ENOUGH = 4;

/** A short reason a source failed, for the trail. */
function why(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  if (/429|challenge|rate-limited|captcha/i.test(m)) return `blocked (${m})`;
  if (/abort/i.test(m)) return 'timed out';
  return m;
}

export async function webSearch(query: string, opts: { kind?: 'web' | 'news'; max?: number } = {}): Promise<SearchOutcome> {
  const max = Math.max(1, Math.min(opts.max ?? 8, 15));
  // Every engine is free and keyless; no library. Web: Parallel's search,
  // then DuckDuckGo's html page, then its lite page (DuckDuckGo blocks some
  // automated requests, so each page gets one retry). News: Parallel's
  // article links, then Bing News (direct links), Google News, Hacker News.
  //
  // How a search is judged: an engine's answer counts only for the results
  // that mention the query (relevant()). Engines are asked in order and their
  // relevant results combined until there are ENOUGH, so one thin or blocked
  // source never decides the answer. Every engine tried is recorded in the
  // trail, so "nothing found" and "everything was blocked" read differently.
  const engines: Array<[string, (q: string, n: number) => Promise<SearchResult[]>]> = opts.kind === 'news'
    ? [['Parallel', parallelNews], ['Bing News', bingNews], ['Google News', googleNews], ['Hacker News', hackerNews]]
    : [['Parallel', parallel], ['DuckDuckGo', ddgHtml], ['DuckDuckGo Lite', ddgLite]];
  const want = Math.min(ENOUGH, max);
  const trail: string[] = [];
  const used: string[] = [];
  let gathered: SearchResult[] = [];
  for (const [name, run] of engines) {
    // DuckDuckGo Lite is the same index as DuckDuckGo: skip it once that answered.
    if (name === 'DuckDuckGo Lite' && used.includes('DuckDuckGo')) continue;
    try {
      const raw = await run(query, max);
      const fresh = relevant(query, raw);
      const before = gathered.length;
      gathered = dedupe([...gathered, ...fresh]);
      const added = gathered.length - before;
      if (!added) {
        trail.push(`${name}: ${raw.length ? (fresh.length ? 'only duplicates' : 'only unrelated results') : 'no results'}`);
        continue;
      }
      used.push(name);
      trail.push(`${name}: ${added} result${added === 1 ? '' : 's'}`);
      if (gathered.length >= want) break;
    } catch (err) {
      trail.push(`${name}: ${why(err)}`);
    }
  }
  if (!gathered.length) throw new Error(`no source found anything (${trail.join('; ')})`);
  return { results: gathered.slice(0, max), engine: used.join(' + '), trail };
}

export function createWebSearchTool() {
  return tool({
    description:
      'Search the web for current information: news, facts, prices, people, products, anything recent. ' +
      'kind "news" for headlines and recent events (query can be empty for top stories). ' +
      'Returns titles, links, snippets and dates; use fetch_url on a link to read the full page. ' +
      'Use this instead of guessing about anything that may have changed.',
    inputSchema: zodSchema(z.object({
      query: z.string().max(300).describe('What to search for. For top news, use kind "news" and an empty query.'),
      kind: z.enum(['web', 'news']).default('web').optional(),
      max: z.number().int().min(1).max(15).default(8).optional(),
    })),
    execute: async ({ query, kind, max }) => {
      try {
        const { results, engine, trail } = await webSearch(query, { kind: kind ?? 'web', max: max ?? 8 });
        return `${formatResults(results, engine, query, kind ?? 'web')}\n\nSearched: ${trail.join(' → ')}`;
      } catch (err) {
        return `Error: web search found nothing: ${(err as Error).message}. Tell the owner which sources were tried and why each failed; try a shorter or rephrased query once.`;
      }
    },
  });
}
