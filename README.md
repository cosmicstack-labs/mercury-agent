<p align="center">
  <img src="docs/card.png" alt="Mercury — Soul-Driven AI Agent" width="600">
</p>

<p align="center">
  <strong>Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access.</strong>
</p>

<p align="center">
  Runs 24/7 from CLI or Telegram. 21 built-in tools. Extensible skills. Asks before it acts.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cosmicstack/mercury-agent"><img src="https://img.shields.io/npm/v/@cosmicstack/mercury-agent" alt="npm"></a>
  <a href="https://github.com/cosmicstack-labs/mercury-agent"><img src="https://img.shields.io/github/license/cosmicstack-labs/mercury-agent" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@cosmicstack/mercury-agent" alt="node"></a>
</p>

---

## Quick Start

```bash
npx @cosmicstack/mercury-agent
```

Or install globally:

```bash
npm i -g @cosmicstack/mercury-agent
mercury
```

First run triggers the setup wizard — enter your name, an API key, and optionally a Telegram bot token. Takes 30 seconds.

## Why Mercury?

Every AI agent can read files, run commands, and fetch URLs. Most do it silently. **Mercury asks first.**

- **Permission-hardened** — Shell blocklist (`sudo`, `rm -rf /`, etc. never execute). Folder-level read/write scoping. Pending approval flow. Skill elevation with granular `allowed-tools`. No surprises.
- **Soul-driven** — Personality defined by markdown files you own (`soul.md`, `persona.md`, `taste.md`, `heartbeat.md`). No corporate wrapper.
- **Token-aware** — Daily budget enforcement. Auto-concise when over 70%. `/budget` command to check, reset, or override.
- **Multi-channel** — CLI with real-time streaming. Telegram with HTML formatting, file uploads, and typing indicators.
- **Always on** — Cron scheduling, delayed reminders, heartbeat monitoring, and proactive notifications.
- **Extensible** — Install community skills with a single command. Schedule skills as recurring tasks. Based on the [Agent Skills](https://agentskills.io) specification.

## Built-in Tools

| Category | Tools |
|----------|-------|
| **Filesystem** | `read_file`, `write_file`, `create_file`, `edit_file`, `list_dir`, `delete_file`, `send_file` |
| **Shell** | `run_command`, `approve_command` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push` |
| **Web** | `fetch_url` |
| **Skills** | `install_skill`, `list_skills`, `use_skill` |
| **Scheduler** | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` |
| **System** | `budget_status` |

## Channels

| Channel | Features |
|---------|----------|
| **CLI** | Readline prompt, real-time text streaming, markdown rendering, file display |
| **Telegram** | HTML formatting, file uploads (photos, audio, video, documents), typing indicators, `/budget` commands |

## Scheduler

- **Recurring**: `schedule_task` with cron expressions (`0 9 * * *` for daily at 9am)
- **One-shot**: `schedule_task` with `delay_seconds` (e.g. 15 seconds)
- Tasks persist to `~/.mercury/schedules.yaml` and restore on restart
- Responses route back to the channel where the task was created

## Configuration

All runtime data lives in `~/.mercury/` — not in your project directory.

| Path | Purpose |
|------|---------|
| `~/.mercury/mercury.yaml` | Main config (providers, channels, budget) |
| `~/.mercury/soul/*.md` | Agent personality (soul, persona, taste, heartbeat) |
| `~/.mercury/permissions.yaml` | Capabilities and approval rules |
| `~/.mercury/skills/` | Installed skills |
| `~/.mercury/schedules.yaml` | Scheduled tasks |
| `~/.mercury/token-usage.json` | Daily token usage tracking |
| `~/.mercury/memory/` | Short-term, long-term, episodic memory |

## Provider Fallback

Configure multiple LLM providers. Mercury tries them in order and falls back automatically:

- **DeepSeek** — default, cost-effective
- **OpenAI** — GPT-4o-mini and others
- **Anthropic** — Claude and others

## Architecture

- **TypeScript + Node.js 20+** — ESM, tsup build, zero native dependencies
- **Vercel AI SDK v4** — `generateText` + `streamText`, 10-step agentic loop, provider fallback
- **grammY** — Telegram bot with typing indicators and file uploads
- **Flat-file persistence** — No database. YAML + JSON in `~/.mercury/`

## License

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)