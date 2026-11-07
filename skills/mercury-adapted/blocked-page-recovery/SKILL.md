---
name: mercury-blocked-page-recovery
description: Recover a blocked, rate-limited or paywalled page through archive and API routes while keeping provenance honest.
category: research
id: research/blocked-page-recovery
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the Hermes blocked-page-recovery workflow. No upstream script is bundled; every route is described as a bounded manual procedure.
license: MIT
intents: [the page is blocked, fetch returned 403, recover a paywalled article, get an archived copy of a page]
tags: [archives, wayback, paywall, fallback, provenance]
allowed-tools: [fetch_url, run_command, read_file, ask_user, use_skill]
---

# Mercury Blocked Page Recovery

Curated independent workflow, not a verified self-made procedure. Use it when a legitimate read fails — 403, 429, a bot challenge, a paywall interstitial — and you need the content, or an honest statement that it is unavailable.

## Ground rules first

Recovering a page for reference is not permission to defeat authentication. Never use this to read content behind an account you do not have, to bypass a paid subscription, to access private or personal data, or to ignore a site's stated terms. If the material is genuinely access-controlled, say so and ask the user how to proceed. Never send cookies, tokens or authorization headers through a third-party proxy: a relay is a man in the middle by construction, and its output has no verifiable provenance.

Follow the site's robots policy and rate limits. Space attempts, use bounded timeouts, and stop after a small number of failures instead of hammering the same host.

## The ladder, cheapest first

1. **Wayback Machine.** Ask the availability API for the closest snapshot, then fetch that snapshot URL. The CDX index enumerates multiple captures for deleted or heavily changed pages; it returns 503 under load, so fall back rather than retrying in a loop.
2. **archive.today family.** User-submitted captures, often covering paywalled news that Wayback lacks. The domains rotate, so try each in turn with a short timeout. It rate-limits aggressively.
3. **API-first pivot.** After two or three blocked attempts, stop fighting the HTML. Look for a JSON endpoint, a GraphQL route, a feed, or a sitemap on the same host that is not gated the same way. Data endpoints are usually protected far less than rendered pages.
4. **Server-side reader service.** Only when the user already configured credentials for it, and only when sending the URL to that service is acceptable. Never invent a key or assume anonymous access works.
5. **Real browser session.** The most expensive rung, and the last. Use it for repeated access only when a permitted interactive session is the honest route.

If the destination is a downloadable file behind an interstitial, resolve the final file URL and fetch the bytes directly rather than rendering the wrapper.

## Validate the body, never the status code

Several routes return HTTP 200 with a plausible body that is not the page. Reject these explicitly:

- A body below a per-route byte floor.
- A meta-refresh or JavaScript redirect stub whose target is the original blocked URL. AMP caches commonly return a few hundred bytes of this.
- Interstitial titles such as a challenge page, "Redirecting", or a search-engine wrapper. Google's cache endpoint has returned exactly that since it was retired, so treat it as dead rather than as a fallback.
- Rate-limit HTML from an archive service, which is several kilobytes of text and passes a naive size check.

Confirm the recovered body actually contains the target's identifying content — title words, a known phrase, the expected structure. A body that merely parses is not the article.

## Provenance discipline

Every recovered copy carries a provenance that must survive into your answer:

- **Snapshot:** cite with the capture date, for example "as archived on 2026-08-06". Never present a snapshot as the live page.
- **Live re-render or live fetch:** cite normally, and say which.

When the user needs current facts — prices, availability, breaking news — an archived copy is context, not an answer. State its age and say the live page could not be read. For citation formatting use `mercury-grounded-citations`.

## Reporting

Say which routes were attempted with what observable result, which route produced the content, and what remains unverified. "Not retrievable from the routes I tried" is a correct answer; "the page does not exist" is not, unless you established it. Never fabricate a quotation to fill a gap, and never present reconstructed text as quoted source. If a paywall blocked legitimate access, offer to work from an abstract, a different source, or the user's own copy — that choice belongs to the user, and obtaining that copy is an approval decision, not an inference. Keep recovered-source locations out of files; if the user wants a source remembered, use the Second Brain rather than a scratch note.
