export interface DefaultSkillSeed {
  dirName: string;
  fileName: string;
  content: string;
}

/** Category labels shown to the user in grouped skill output */
export const CATEGORY_LABELS: Record<string, string> = {
  web: 'Web & Research',
  social: 'Social Media',
  media: 'Media & Downloads',
  productivity: 'Productivity',
  system: 'System Administration',
  development: 'Development',
  uncategorized: 'Other',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category.charAt(0).toUpperCase() + category.slice(1);
}

export const DEFAULT_SKILL_SEEDS: DefaultSkillSeed[] = [
  {
    dirName: 'browser-research',
    fileName: 'SKILL.md',
    content: `---
name: browser-research
description: Research the live web. Picks the cheapest viable tool — fetch_url for plain HTML, browser_* for JavaScript-rendered or interactive sites, browser_task for delegated agent jobs.
version: 1.0.0
category: web
categories:
  - web
  - research
intents:
  - search the web
  - look up
  - find online
  - what is
  - current news
  - search for
  - find information about
  - research
  - web search
  - browse to
  - extract from website
  - scrape
  - check the page
tags:
  - search
  - web
  - research
  - browser
  - scraping
allowed-tools:
  - fetch_url
  - browser_open
  - browser_state
  - browser_click
  - browser_type
  - browser_extract
  - browser_screenshot
  - browser_close
  - browser_task
  - approve_url_scope
---

# Browser Research

End-to-end web research: pick the cheapest tool that can answer the question, escalate only when needed, and always release Cloud sessions when done.

## Tool ladder (cheap → expensive)

1. **\`fetch_url\`** — first choice. Static HTML, RSS, JSON, plain article pages, GitHub READMEs, docs sites. Zero cost, instant, offline-safe.
2. **\`browser_open\` + \`browser_state\` + \`browser_extract\`** — when fetch_url returns a near-empty body, a "Please enable JavaScript" notice, or a SPA shell. Reads the rendered DOM.
3. **\`browser_open\` + \`browser_type\`/\`browser_click\`** — when you need to fill a search box, log in, paginate, or click through to a detail page.
4. **\`browser_task\`** — only when the LLM judges the page-by-page loop will be slow or fragile (multi-site comparisons, deep multi-step flows). Delegates to Browser-Use Cloud's own agent. Costs more per call than steps 1–3.

Never skip ahead. If fetch_url works, use only fetch_url. Escalating early wastes Cloud session minutes.

## Workflow

### 1. Plain search

If the user wants a quick web search:

1. Build a DuckDuckGo HTML URL: \`https://html.duckduckgo.com/html/?q=<encoded-query>\`
2. \`fetch_url\` it in markdown format. The result includes ranked links.
3. Pick the top 1–3 relevant links and \`fetch_url\` each.
4. Cross-check key facts across at least two sources when possible.
5. Reply with the answer, source URLs, and any caveats.

### 2. JavaScript-rendered page

If \`fetch_url\` on the target returns an empty or skeleton page:

1. \`browser_open\` the URL. Mercury will pick Cloud or Local automatically.
2. \`browser_state\` to see the interactive elements + URL + title.
3. \`browser_extract\` with no selector to get the rendered text, or with a CSS selector (e.g. \`article\`, \`.result\`) for precision.
4. \`browser_close\` immediately when done. Cloud sessions are billed by the minute.

### 3. Interactive flow

For tasks that need form filling or navigation (search inside a site, login, paginate, click into details):

1. \`browser_open\` the entry URL.
2. \`browser_state\` — note the index of the search box / submit button.
3. \`browser_type\` text into it, with \`submit: true\` if Enter triggers the search.
4. \`browser_state\` again — the page has changed; indices have changed.
5. \`browser_click\` the result you want.
6. Repeat state→click as needed.
7. \`browser_extract\` to pull the answer.
8. \`browser_close\`.

### 4. Delegated task

When the task is multi-site, requires complex reasoning, or you've tried steps 1–3 and they're brittle:

1. \`browser_task\` with a precise English description. Include the output format you want (\`as a markdown list\`, \`as JSON with these keys\`, etc.).
2. Optionally pass \`starting_urls\` for sites the agent should consider.
3. The remote agent runs on a stealth Cloud browser with residential proxies — good for sites that block scrapers.

## Sensitive domains

Banks, email providers, government sites, and crypto exchanges always route through the **Local** backend with a persistent profile (so logged-in state survives). This is non-negotiable: Mercury will never send credentials to the Cloud backend even if the user asks.

If the user wants you to use one of these and Local isn't installed, instruct them to run \`mercury browser install\`.

## Permission flow

The first time you hit a domain that isn't on the allowlist, the user is prompted to approve it. If you expect to revisit a domain, that approval is remembered.

Power users can pre-approve domains with the \`approve_url_scope\` tool or \`mercury browser allow <domain>\` from the CLI.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in your reply.
- Never fabricate citations or quotes.
- Close every browser session when done. Forgetting to close costs the user money.
- If a Cloud call fails with "budget exhausted", fall back to Local (sensitive routing aside) or tell the user their budget is hit.
`,
  },
  {
    dirName: 'tweet-notifier',
    fileName: 'SKILL.md',
    content: `---
name: tweet-notifier
description: Schedule tweets with notifications to founders and supporters. Alerts founders when tweets are scheduled, and notifies supporters (approved Telegram users) when tweets are pending approval.
version: 1.0.0
category: social
categories:
  - social
  - communication
intents:
  - schedule tweet
  - approve tweet
  - post tweet
  - reject tweet
  - pending tweets
  - show tweets
  - notify supporters
  - cancel tweet
  - tweet approval
  - schedule a tweet
tags:
  - twitter
  - tweet
  - scheduling
  - notification
  - social media
allowed-tools:
  - schedule_task
  - send_message
  - save_memory
  - search_memory
  - fetch_url
  - github_api
---

# Tweet Notifier

Notification system for tweet scheduling and approval workflows. Alerts the founder (Optimus Prime) and supporters (approved Telegram users) at key states of the tweet lifecycle.

## States

| State | Description | Notification Sent To |
|---|---|---|
| \`draft\` | Tweet is being composed | None (internal) |
| \`scheduled\` | Tweet is queued with a time | Founder (send_message) |
| \`pending_approval\` | Tweet needs review before posting | Founder + Supporters (send_message) |
| \`approved\` | Tweet is cleared to post | Founder + Supporters |
| \`posted\` | Tweet has been published | Supporters |
| \`cancelled\` | Tweet was cancelled | Founder |

## Workflow

When the user wants to schedule or approve a tweet:

### 1. Schedule a Tweet

1. Ask for the tweet content and desired posting time
2. Use \`save_memory\` to store the tweet as a memory with type \`project\`:
   - Summary: "Tweet: [content preview] scheduled for [time]"
   - Include detail with full tweet content, scheduled time, status
3. Use \`send_message\` to alert the founder:
   - \`📅 **Tweet Scheduled** — @[time]: "[content preview]"\\nStatus: pending_approval — needs review before posting.\`
4. Use \`schedule_task\` to set a delayed task:
   - \`delay_seconds\`: seconds until posting time
   - \`description\`: "Post scheduled tweet: [content preview]"
   - \`prompt\`: "The following tweet is scheduled to post now. Check memory for full content and status. If approved, post it. If pending_approval, remind the user first."

### 2. Tweet Requires Approval (Pending)

When a tweet is in \`pending_approval\` state:

1. Use \`send_message\` to notify the founder:
   - \`✋ **Tweet Pending Approval** — "[content preview]"\\nPlease review and approve or reject this tweet.\\nTo approve, say: approve tweet [id]\\nTo reject, say: reject tweet [id]\`
2. Use \`send_message\` to notify supporters (approved Telegram users):
   - \`📢 **New Tweet for Review** — A new tweet is pending approval:\\n> "[content preview]"\\nThe founder will review it shortly.\`

### 3. Approve or Reject a Tweet

When the user approves:

1. Use \`save_memory\` to update the tweet status to \`approved\`
2. Use \`send_message\` to alert supporters:
   - \`✅ **Tweet Approved** — "[content preview]"\\nThis tweet has been approved and will be posted at [time].\`
3. If immediate posting, use \`fetch_url\` or \`github_api\` as appropriate for the posting platform
4. Use \`send_message\` to notify supporters after posting:
   - \`🐦 **Tweet Posted** — "[content preview]"\\nView it at: [url]\`

When the user rejects:

1. Use \`save_memory\` to update the tweet status to \`cancelled\`
2. Use \`send_message\` to notify supporters:
   - \`🚫 **Tweet Cancelled** — "[content preview]" was not approved for posting.\`

### 4. Check Scheduled Tweets

When asked "what tweets are scheduled" or "show pending tweets":

1. Use \`search_memory\` with query "tweet" and type filter for \`project\`
2. Summarize all tweets with their status, content preview, and scheduled time
3. Present them grouped by status (pending_approval, approved, scheduled)

## Notification Flow Examples

### Founder Notification (via send_message)
\`\`\`
📅 Tweet Scheduled — @2:30 PM PST: "Exciting new features coming soon..."
Status: pending_approval — needs review before posting.
To approve, say: approve tweet t1
To reject, say: reject tweet t1
\`\`\`

### Supporter Notification (via send_message)
\`\`\`
📢 New Tweet for Review

A new tweet is pending approval:

> "Exciting new features coming soon..."

The founder will review it shortly. Stay tuned!
\`\`\`

## Memory Schema

Store each tweet as a memory with:
- Type: \`project\`
- Summary: \`Tweet: [preview] scheduled for [time] — status: [state]\`
- Detail: \`{"content": "full tweet text", "scheduledAt": "ISO time", "status": "draft|scheduled|pending_approval|approved|posted|cancelled", "id": "unique-id"}\`
- Confidence: 0.95
- Importance: 0.8
`,
  },
];
