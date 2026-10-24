import type { SearchResult } from './web-search.js';

/**
 * Last-resort web search through a model provider the owner already set up
 * (Anthropic or OpenAI). The free engines are scraped, and scraping gets
 * blocked; these are official search APIs behind keys Mercury already has,
 * so no new key is ever asked for. They cost a little per search, which is
 * why web_search only reaches them when every free engine came back empty.
 */

export interface ProviderKey {
  name: 'anthropic' | 'openai';
  apiKey: string;
  baseUrl: string;
}

const TIMEOUT_MS = 30_000;
/** A small, fast model is enough: it only runs the search. */
const ANTHROPIC_SEARCH_MODEL = 'claude-haiku-4-5';
const OPENAI_SEARCH_MODEL = 'gpt-4.1-mini';

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic's server-side web_search tool: results come back as web_search_result blocks. */
export function parseAnthropicSearch(data: unknown, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = (data as { content?: Array<Record<string, unknown>> })?.content ?? [];
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const hit of block.content as Array<Record<string, unknown>>) {
      if (hit.type !== 'web_search_result' || typeof hit.url !== 'string') continue;
      out.push({ title: String(hit.title ?? hit.url), url: hit.url, snippet: '', date: typeof hit.page_age === 'string' ? hit.page_age : undefined });
      if (out.length >= max) return out;
    }
  }
  // The model's own answer cites the pages it used, with the quoted text: use
  // those quotes as snippets.
  for (const block of blocks) {
    for (const c of (block.citations as Array<Record<string, unknown>> | undefined) ?? []) {
      const hit = out.find((r) => r.url === c.url);
      if (hit && !hit.snippet && typeof c.cited_text === 'string') hit.snippet = c.cited_text.slice(0, 300);
    }
  }
  return out;
}

/** OpenAI's Responses API web_search tool: sources arrive as url_citation annotations. */
export function parseOpenAiSearch(data: unknown, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of (data as { output?: Array<Record<string, unknown>> })?.output ?? []) {
    for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
      const text = typeof part.text === 'string' ? part.text : '';
      for (const a of (part.annotations as Array<Record<string, unknown>> | undefined) ?? []) {
        if (a.type !== 'url_citation' || typeof a.url !== 'string') continue;
        const url = a.url.replace(/[?&]utm_source=openai$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        const start = typeof a.start_index === 'number' ? a.start_index : 0;
        out.push({ title: String(a.title ?? url), url, snippet: text.slice(Math.max(0, start - 200), start).replace(/\s+/g, ' ').trim().slice(-300) });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export async function providerSearch(key: ProviderKey, query: string, max: number): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const ask = `Search the web for: ${query}\nList the most relevant pages. Be brief.`;
  if (key.name === 'anthropic') {
    const base = (key.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    const data = await post(`${base}/v1/messages`, { 'x-api-key': key.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: ANTHROPIC_SEARCH_MODEL,
      max_tokens: 600,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: ask }],
    });
    return parseAnthropicSearch(data, max);
  }
  const base = (key.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const data = await post(`${base}/responses`, { Authorization: `Bearer ${key.apiKey}` }, {
    model: OPENAI_SEARCH_MODEL,
    tools: [{ type: 'web_search' }],
    input: ask,
  });
  return parseOpenAiSearch(data, max);
}
