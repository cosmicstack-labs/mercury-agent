# Release v1.4.1

## ☿ Mercury Agent v1.4.1

Mercury now learns how you like to work, saves the procedures it repeats as its own skills, and its free web search returns real results again. The terminal got a round of fixes too: pickers that work in the attached terminal, a status row that stays useful, and no more "Thinking" forever after `/new`.

### Mercury learns how to work with you (ADR-026)
- **Memory became beliefs with evidence.** Each thing Mercury believes about you has support, a confidence that fades unless it is seen again, and a status: candidate, held, confirmed by you, contested, retired or forgotten.
- **It learns working traits**: reply length, when to ask before acting, options or a recommendation, tone, your expertise per domain. Never health, religion, politics or credentials.
- **You hear about it.** Behaviour-changing learning ends a reply with one line, `☿ Noted: …`, and "forget that" undoes it. `/memory learned`, `/memory beliefs`, `/forget <text>` and the dashboard show and edit what it holds.
- **One source.** Every surface reads and writes the same belief store. Your name and handles stay in `identity.owner` in `mercury.yaml`.
- **Pick the model that learns** with `memory.learning.provider`, so extraction runs on a capable model while chat keeps its own.
- **Safe upgrade.** The first start backs up `second-brain.db` to `second-brain.pre-owner-model.db`, migrates once, and quarantines (never deletes) junk rows the old extractor saved.

### Self-made skills (ADR-027)
- After a multi-step task it would do again has worked end to end, Mercury can save the procedure as a skill and reuse it next time.
- Self-made skills live in `~/.mercury/skills/self-made/`, are listed apart from yours, go dormant after 30 days unused, and the shelf is capped at 40. Review them with `/skills self-made`.
- Skill categories and intent routing work again (discovery was wiping them).

### Web search that works, still keyless
- Bing's web RSS feed now answers automated requests with unrelated pages, and DuckDuckGo blocks them. `web_search` now asks Brave Search first, then Wikipedia, Hacker News, Bing News and Google News, and keeps only results that mention your query.
- `fetch_url` on a search results page runs a real search instead of returning a block page, and an installed web-search skill that scrapes DuckDuckGo is replaced by the built-in one (your copy is kept as `SKILL.md.replaced.bak`).

### Terminal
- **Every new session asks Ask Me or Allow All**, with your current mode first so Enter keeps it.
- **Pickers work in the attached terminal**: `/model`, `/cloud`, `/permissions` and questions from Mercury. Answers used to be dropped, leaving the command waiting two minutes behind a spinner.
- **`/new` no longer leaves the screen "Thinking" forever**: the terminal now follows the new session.
- **One status row**: session, mode, today's budget meter (green, yellow, red), model. Optimus activity always stays visible. The live spinner sits above the input. Mercury Code uses the same row.
- Chat works like an agent again: real tools (pandoc, ffmpeg, a script) for bulk work instead of file-by-file edits.

### Upgrade

**npm:**
```
npm install -g @cosmicstack/mercury-agent@1.4.1
mercury restart
```

**Standalone binary:** `mercury upgrade`, or re-run the one-line installer from mercuryagent.sh.

No config changes needed. Your memory is backed up before the one-time migration.

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v1.4.0...v1.4.1
