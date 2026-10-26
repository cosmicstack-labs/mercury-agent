# Release v1.4.2

## ☿ Mercury Agent v1.4.2

Web search finds things again, with no key and with any model, and the research prompt now asks only when you actually want a research article.

### Web search
- **Three sources that answer.** `web_search` asks [Parallel's public search](https://search.parallel.ai/mcp) first (keyless, built for agents, about a second, with excerpts and dates), then DuckDuckGo's html page, then its lite page. Bing's web feed, which had started returning unrelated pages, and the engines that refuse automated requests are gone.
- **DuckDuckGo read exactly.** Both pages are parsed from their real markup: the title, the real address behind DuckDuckGo's redirect, and the snippet. Ads are dropped, a bot challenge is retried once, and a page Mercury can't read is reported instead of looking empty.
- **News links open the article.** News comes from Parallel's article links, then Bing News with its redirects unwrapped to the publisher, then Google News and Hacker News.
- **Never the model's own search.** Results come only from Mercury's search tools, so search works the same whichever model you use.
- **You can see what happened.** Every result ends with a `Searched:` trail, such as `Parallel: timed out → DuckDuckGo: 8 results`, so "nothing found" and "every source was blocked" read differently.
- The built-in `web-search` skill (1.3.0) describes the sources. An installed skill that scraped DuckDuckGo directly is replaced, and your copy is kept as `SKILL.md.replaced.bak`.

### Chat
- **The research prompt asks only when you mean it.** It used to fire on words like "latest" or "explain", so instructions such as "convert the latest epub" got a research question. One short model call now decides; instructions, quick questions and today's news never get the prompt.
- **Quick answer comes first**, so an accidental Enter never starts a long research run.

### Upgrade

**npm:**
```
npm install -g @cosmicstack/mercury-agent@1.4.2
mercury restart
```

**Standalone binary:** `mercury upgrade`, or re-run the one-line installer from mercuryagent.sh.

No config changes needed.

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v1.4.1...v1.4.2
