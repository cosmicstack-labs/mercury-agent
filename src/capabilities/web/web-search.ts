import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { guardedFetch } from '../../utils/ssrf.js';
import { providerSearch, type ProviderKey } from './provider-search.js';

/**
 * web_search: free, keyless search for the model.
 *
 *   web  → Brave Search, DuckDuckGo (html, then lite), then Wikipedia, Hacker News,
 *           Bing News, Google News, Bing RSS
 *   news → Bing News (direct article links), then Google News (top stories, or
 *           when Bing has nothing; its links are Google redirects), Hacker News
 *
 * Every answer must mention the query (relevant()); an engine serving junk
 * counts as empty and the next one is tried.
 *
 * Read-only and through the same SSRF guard as fetch_url. Returns titles,
 * links, snippets and dates; the model follows up with fetch_url to read a
 * page. (DuckDuckGo's HTML endpoint answers automated requests with a 202
 * challenge, which is why the old search skill often came back empty.)
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

/**
 * Bing's web RSS feed. Kept as a late fallback only: since autumn 2026 it
 * answers automated requests with results unrelated to the query, which the
 * relevance check below throws away.
 */
async function bing(query: string, max: number): Promise<SearchResult[]> {
  return parseRss(await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.min(20, max + 2)}`), max);
}

/** Bing News RSS: relevant, recent, keyless. */
async function bingNews(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return parseRss(await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`), max);
}

/**
 * Brave Search's results page: a real, independent web index that answers a
 * plain browser request without a key or a challenge. Parsed from the HTML,
 * so a markup change shows up as "no results" and the chain moves on.
 */
export function parseBrave(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const anchor = /<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) && out.length < max) {
    const [, url, inner] = m;
    const title = /class="title search-snippet-title[^"]*"[^>]*title="([^"]*)"/.exec(inner)?.[1];
    if (!title || /^https?:\/\/([a-z]+\.)?search\.brave\.com/.test(url)) continue;
    const after = html.slice(anchor.lastIndex, anchor.lastIndex + 4000);
    const nextResult = after.search(/<a href="https?:\/\/[^"]+"[^>]*>[\s\S]{0,3000}?search-snippet-title/);
    const scope = nextResult > 0 ? after.slice(0, nextResult) : after;
    const snippet = /class="content[^"]*">([\s\S]*?)<\/div>/.exec(scope)?.[1] ?? '';
    out.push({ title: decode(title), url: unescape(url), snippet: decode(snippet).slice(0, 300) });
  }
  return out;
}

/**
 * DuckDuckGo's no-JavaScript result pages (html. and lite.). Links come as
 * duckduckgo.com/l/?uddg=<the page>; ads point back at duckduckgo.com and
 * are dropped. DuckDuckGo answers some automated requests with a challenge
 * page (HTTP 202, "anomaly"), which counts as a failure so the chain moves on.
 */
export function parseDdg(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const anchor = /<a[^>]*class=["'](?:result__a|result-link)["'][^>]*>[\s\S]*?<\/a>|<a[^>]*href="[^"]*"[^>]*class=["'](?:result__a|result-link)["'][^>]*>[\s\S]*?<\/a>/g;
  const found = [...html.matchAll(anchor)];
  for (let i = 0; i < found.length && out.length < max; i++) {
    const tagText = found[i][0];
    const href = /href="([^"]+)"/.exec(tagText)?.[1];
    if (!href) continue;
    let url = unescape(href);
    try {
      const u = new URL(url.startsWith('//') ? `https:${url}` : url);
      url = u.searchParams.get('uddg') ?? u.href;
    } catch { continue; }
    if (!/^https?:\/\//.test(url) || /^https?:\/\/([a-z]+\.)?duckduckgo\.com\//.test(url)) continue;
    const title = decode(tagText.replace(/^<a[^>]*>/, '').replace(/<\/a>$/, ''));
    const start = (found[i].index ?? 0) + tagText.length;
    const end = i + 1 < found.length ? found[i + 1].index ?? html.length : Math.min(html.length, start + 4000);
    const scope = html.slice(start, end);
    const snippet = /class=["'](?:result__snippet|result-snippet)["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(scope)?.[1] ?? '';
    if (title) out.push({ title, url, snippet: decode(snippet).slice(0, 300) });
  }
  return out;
}

async function ddg(kind: 'html' | 'lite', query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(`https://${kind}.duckduckgo.com/${kind}/?q=${encodeURIComponent(query)}`, ac.signal, { 'User-Agent': UA, Accept: 'text/html' });
    const body = await res.text();
    if (res.status === 202 || /anomaly/i.test(body)) throw new Error('bot challenge');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDdg(body, max);
  } finally {
    clearTimeout(timer);
  }
}
const ddgHtml = (q: string, n: number) => ddg('html', q, n);
const ddgLite = (q: string, n: number) => ddg('lite', q, n);

/** Brave rate-limits per IP: after a 429 it is skipped for a minute rather than tried (and waited on) every query. */
const BRAVE_COOLDOWN_MS = 60_000;
let braveBlockedUntil = 0;
export function resetBraveCooldown(): void { braveBlockedUntil = 0; }

async function brave(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  if (Date.now() < braveBlockedUntil) throw new Error('rate-limited, resting for a minute');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, ac.signal, { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' });
    if (res.status === 429) braveBlockedUntil = Date.now() + BRAVE_COOLDOWN_MS;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseBrave(await res.text(), max);
  } finally {
    clearTimeout(timer);
  }
}

async function googleNews(query: string, max: number): Promise<SearchResult[]> {
  const url = query.trim()
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  return parseRss(await fetchText(url), max);
}

async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url));
}

/** Wikipedia's search API: keyless JSON, strong for facts, people, places, concepts. */
export async function wikipedia(query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(10, max)}&srprop=snippet|timestamp`) as {
    query?: { search?: Array<{ title: string; snippet?: string; timestamp?: string }> };
  };
  return (data.query?.search ?? []).map((hit) => ({
    title: hit.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
    snippet: decode(hit.snippet ?? '').slice(0, 300),
    source: 'Wikipedia',
    date: hit.timestamp,
  }));
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
  /** The engines whose results are in the answer, e.g. "Brave + DuckDuckGo". */
  engine: string;
  /** What each engine tried did: "Brave: blocked (HTTP 429)", "DuckDuckGo: 6 results". */
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

/**
 * The provider keys web_search may fall back to, set at boot from the owner's
 * config (Anthropic first, then OpenAI). Empty means free engines only.
 */
let providerKeys: ProviderKey[] = [];
export function setSearchProviders(keys: ProviderKey[]): void {
  providerKeys = keys.filter((k) => k.apiKey && k.apiKey.length > 8);
}

export async function webSearch(query: string, opts: { kind?: 'web' | 'news'; max?: number; providers?: ProviderKey[] } = {}): Promise<SearchOutcome> {
  const max = Math.max(1, Math.min(opts.max ?? 8, 15));
  // Every engine is free and keyless; no library. Brave and DuckDuckGo are
  // the real web indexes, and both block some automated requests (by client
  // fingerprint and rate), so having two, plus DuckDuckGo's lite page, keeps
  // web search answering. Wikipedia, Hacker News and the news feeds follow.
  // Bing's web RSS is last: it serves unrelated pages to bots.
  //
  // How a search is judged: an engine's answer counts only for the results
  // that mention the query (relevant()). Engines are asked in order and their
  // relevant results combined until there are ENOUGH, so one thin or blocked
  // source never decides the answer. Every engine tried is recorded in the
  // trail, so "nothing found" and "everything was blocked" read differently.
  const engines: Array<[string, (q: string, n: number) => Promise<SearchResult[]>]> = opts.kind === 'news'
    ? [['Bing News', bingNews], ['Google News', googleNews], ['Hacker News', hackerNews]]
    : [['Brave', brave], ['DuckDuckGo', ddgHtml], ['DuckDuckGo Lite', ddgLite], ['Wikipedia', wikipedia], ['Hacker News', hackerNews], ['Bing News', bingNews], ['Google News', googleNews], ['Bing', bing]];
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
  // The free engines could not answer well: both web indexes blocked us, or
  // what came back is too thin. Ask the owner's own model provider, which
  // runs an official search API (a small cost, only on this path).
  const realIndexAnswered = used.some((n) => n === 'Brave' || n.startsWith('DuckDuckGo'));
  if (opts.kind !== 'news' && query.trim() && (gathered.length < want || !realIndexAnswered)) {
    for (const key of opts.providers ?? providerKeys) {
      const name = key.name === 'anthropic' ? 'Anthropic web search' : 'OpenAI web search';
      try {
        const before = gathered.length;
        // Provider results lead: they come from a real index, the rest were fallbacks.
        const fromProvider = await providerSearch(key, query, max);
        gathered = dedupe([...fromProvider, ...gathered]);
        const added = gathered.length - before;
        if (!added) { trail.push(`${name}: no results`); continue; }
        used.unshift(name);
        trail.push(`${name}: ${added} result${added === 1 ? '' : 's'}`);
        break;
      } catch (err) {
        trail.push(`${name}: ${why(err)}`);
      }
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
