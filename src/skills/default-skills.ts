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
    dirName: 'web-search',
    fileName: 'SKILL.md',
    content: `---
name: web-search
description: Perform web searches using DuckDuckGo HTML and summarize sources.
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
tags:
  - search
  - web
  - research
  - duckduckgo
allowed-tools:
  - fetch_url
---

# Web Search

Use this skill when the user asks for current events, external facts, or web research.

## Workflow

1. Build a DuckDuckGo HTML search URL:
   - https://html.duckduckgo.com/html/?q=<query>
2. Use fetch_url with markdown format to retrieve result page content.
3. Extract likely source links and open the top relevant pages with fetch_url.
4. Cross-check key facts across at least 2 sources when possible.
5. Return a concise answer with source links and clear caveats.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in the response.
- Avoid fabricated citations.
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
