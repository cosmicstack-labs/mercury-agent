<p align="center">
  <img src="docs/card.png" alt="Mercury — Soul-Driven AI Agent" width="600">
</p>

<p align="center">
  <strong>Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access.</strong>
</p>

<p align="center">
  Remembers what matters. Asks before it acts. Runs 24/7 from CLI or Telegram. 31 built-in tools, extensible skills, SQLite-backed Second Brain memory.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cosmicstack/mercury-agent"><img src="https://img.shields.io/npm/v/@cosmicstack/mercury-agent" alt="npm"></a>
  <a href="https://github.com/cosmicstack-labs/mercury-agent"><img src="https://img.shields.io/github/license/cosmicstack-labs/mercury-agent" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@cosmicstack/mercury-agent" alt="node"></a>
</p>

<p align="center">
  <a href="https://railway.com/deploy/mercury-agent-railway?referralCode=u71AUL&utm_medium=integration&utm_source=template&utm_campaign=generic">
    <img src="https://railway.com/button.svg" alt="Deploy on Railway">
  </a>
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

To reconfigure later (change keys, name, settings):

```bash
mercury doctor
```

## Why Mercury?

Every AI agent can read files, run commands, and fetch URLs. Most do it silently. **Mercury asks first — and remembers what matters.**

- **Permission-hardened** — Shell blocklist (`sudo`, `rm -rf /`, etc. never execute). Folder-level read/write scoping. Pending approval flow. Ask Me or Allow All per session. No surprises.
- **Second Brain** — Persistent, structured memory with SQLite + FTS5 full-text search. 10 memory types, auto-extraction, conflict resolution, auto-consolidation. Mercury learns your preferences, goals, and habits without manual entry.
- **Soul-driven** — Personality defined by markdown files you own (`soul.md`, `persona.md`, `taste.md`, `heartbeat.md`). No corporate wrapper.
- **Token-aware** — Daily budget enforcement. Auto-concise when over 70%. `/budget` command to check, reset, or override.
- **Live streaming** — Real-time token streaming on CLI with cursor-save/restore and markdown re-rendering. Telegram streaming with editable status messages.
- **Always on** — Run as a background daemon on any OS. Auto-restarts on crash. Starts on boot. Cron scheduling, heartbeat monitoring, and proactive notifications.
- **Extensible** — Install community skills with a single command. Schedule skills as recurring tasks. Based on the [Agent Skills](https://agentskills.io) specification.

## Daemon Mode

**One command to make Mercury persistent:**

```bash
mercury up
```

This installs the system service (if not installed), starts the background daemon, and ensures Mercury is running. Use this as your go-to command.

If Mercury is already running, `mercury up` just confirms it and shows the PID.

### Other daemon commands

```bash
mercury restart      # Restart the background process
mercury stop         # Stop the background process
mercury start -d     # Start in background (without service install)
mercury logs         # View recent daemon logs
mercury status       # Show if daemon is running
```

Daemon mode includes built-in crash recovery — if the process crashes, it restarts automatically with exponential backoff (up to 10 restarts per minute).

### System Service (auto-start on boot)

`mercury up` installs this automatically. You can also manage it directly:

```bash
mercury service install
```

| Platform | Method | Requires Admin |
|----------|--------|---------------|
| **macOS** | LaunchAgent (`~/Library/LaunchAgents/`) | No |
| **Linux** | systemd user unit (`~/.config/systemd/user/`) | No (linger for boot) |
| **Windows** | Task Scheduler (`schtasks`) | No |

```bash
mercury service status     # Check if service is running
mercury service uninstall  # Remove the system service
```

In daemon mode, Telegram becomes your primary channel — CLI is log-only since there's no terminal for input.

## CLI Commands

| Command | Description |
|---------|-------------|
| `mercury up` | **Recommended.** Install service + start daemon + ensure running |
| `mercury` | Start the agent (same as `mercury start`) |
| `mercury start` | Start in foreground |
| `mercury start -d` | Start in background (daemon mode) |
| `mercury restart` | Restart the background process |
| `mercury stop` | Stop a background process |
| `mercury logs` | View recent daemon logs |
| `mercury doctor` | Reconfigure (Enter to keep current values) |
| `mercury setup` | Re-run the setup wizard |
| `mercury status` | Show config and daemon status |
| `mercury help` | Show full manual |
| `mercury upgrade` | Upgrade to latest version |
| `mercury telegram list` | List approved and pending Telegram users |
| `mercury telegram approve <code\|id>` | Approve a pairing code or pending request |
| `mercury telegram reject <id>` | Reject a pending Telegram access request |
| `mercury telegram remove <id>` | Remove an approved Telegram user |
| `mercury telegram promote <id>` | Promote a Telegram member to admin |
| `mercury telegram demote <id>` | Demote a Telegram admin to member |
| `mercury telegram reset` | Clear all Telegram access and start fresh |
| `mercury service install` | Install as system service (auto-start on boot) |
| `mercury service uninstall` | Uninstall system service |
| `mercury service status` | Show system service status |
| `mercury --verbose` | Start with debug logging |

## In-Chat Commands

Type these during a conversation — they don't consume API tokens. Work on both CLI and Telegram.

| Command | Description |
|---------|-------------|
| `/help` | Show the full manual |
| `/status` | Show agent config, budget, and usage |
| `/tools` | List all loaded tools |
| `/skills` | List installed skills |
| `/stream` | Toggle Telegram text streaming |
| `/stream off` | Disable streaming (single message) |
| `/budget` | Show token budget status |
| `/budget override` | Override budget for one request |
| `/budget reset` | Reset usage to zero |
| `/budget set <n>` | Change daily token budget |
| `/permissions` | Change permission mode (Ask Me / Allow All) |
| `/tasks` | List scheduled tasks |
| `/memory` | View and manage second brain memory |
| `/unpair` | Telegram: reset all access |

## Built-in Tools

| Category | Tools |
|----------|-------|
| **Filesystem** | `read_file`, `write_file`, `create_file`, `edit_file`, `list_dir`, `delete_file`, `send_file`, `approve_scope` |
| **Shell** | `run_command`, `cd`, `approve_command` |
| **Messaging** | `send_message` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push` |
| **Web** | `fetch_url` |
| **Skills** | `install_skill`, `list_skills`, `use_skill` |
| **Scheduler** | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` |
| **System** | `budget_status` |

## Channels

| Channel | Features |
|---------|----------|
| **CLI** | Readline prompt, arrow-key command menus, real-time text streaming with markdown re-rendering, permission mode picker |
| **Telegram** | HTML formatting, editable streaming messages, file uploads, typing indicators, multi-user access with admin/member roles |

### Telegram Access

Mercury uses an **organization access model** with admins and members.

- **First-time setup:** Send `/start` to your bot, receive a pairing code, enter it in the CLI with `mercury telegram approve <code>`. You become the first admin.
- **Additional users:** Send `/start` to request access. Admins approve or reject from the CLI.
- **Roles:** Admins can approve/reject requests, promote/demote users, and reset access. Members can chat with Mercury.
- **Reset:** Admins can send `/unpair` in Telegram or run `mercury telegram reset` in the CLI to clear all access and start fresh.
- Private chats only — group messages are always ignored.

CLI commands: `mercury telegram list|approve|reject|remove|promote|demote|reset`

## Scheduler

- **Recurring**: `schedule_task` with cron expressions (`0 9 * * *` for daily at 9am)
- **One-shot**: `schedule_task` with `delay_seconds` (e.g. 15 seconds)
- Tasks persist to `~/.mercury/schedules.yaml` and restore on restart
- Responses route back to the channel where the task was created

## Second Brain

Mercury builds a structured, persistent memory that grows with every conversation. Enabled by default, it automatically extracts, stores, and recalls facts about you.

- **10 memory types** — identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection
- **Automatic extraction** — after each conversation, Mercury pulls 0–3 facts with confidence, importance, and durability scores
- **Relevant recall** — before each message, the top 5 matching memories (900-char budget) are injected into context
- **Auto-consolidation** — every 60 min, Mercury builds a profile summary, active-state summary, and generates reflections from patterns
- **Conflict resolution** — opposing memories are resolved by confidence (higher wins) or recency (newer wins)
- **Auto-pruning** — active-scope memories stale after 21 days; inferred memories decay; low-confidence durable memories dismissed after 120 days
- **User controls** — `/memory` for overview, search, pause, resume, and clear
- **Disable** — `SECOND_BRAIN_ENABLED=false` env var or `memory.secondBrain.enabled: false` in config

All data stays on your machine in `~/.mercury/memory/second-brain/second-brain.db` (SQLite + FTS5). No cloud.

## Configuration

All runtime data lives in `~/.mercury/` — not in your project directory.

| Path | Purpose |
|------|---------|
| `~/.mercury/mercury.yaml` | Main config (providers, channels, budget) |
| `~/.mercury/.env` | API keys and tokens (loaded alongside project .env) |
| `~/.mercury/soul/*.md` | Agent personality (soul, persona, taste, heartbeat) |
| `~/.mercury/permissions.yaml` | Capabilities and approval rules |
| `~/.mercury/skills/` | Installed skills |
| `~/.mercury/schedules.yaml` | Scheduled tasks |
| `~/.mercury/token-usage.json` | Daily token usage tracking |
| `~/.mercury/memory/short-term/` | Per-conversation JSON files |
| `~/.mercury/memory/long-term/` | Auto-extracted facts (JSONL) |
| `~/.mercury/memory/episodic/` | Timestamped event log (JSONL) |
| `~/.mercury/memory/second-brain/` | Structured memory database (SQLite + FTS5) |
| `~/.mercury/daemon.pid` | Background process PID |
| `~/.mercury/daemon.log` | Daemon mode logs |

## Provider Fallback

Configure multiple LLM providers. Mercury tries them in order and falls back automatically:

| Provider | Default Model | API Key | Notes |
|----------|--------------|---------|-------|
| **DeepSeek** | deepseek-chat | `DEEPSEEK_API_KEY` | Default, cost-effective |
| **OpenAI** | gpt-4o-mini | `OPENAI_API_KEY` | GPT-4o, o3, etc. |
| **Anthropic** | claude-sonnet-4 | `ANTHROPIC_API_KEY` | Claude Sonnet, Haiku, Opus |
| **Grok (xAI)** | grok-4 | `GROK_API_KEY` | OpenAI-compatible endpoint |
| **Ollama Cloud** | gpt-oss:120b | `OLLAMA_CLOUD_API_KEY` | Remote Ollama via API |
| **Ollama Local** | gpt-oss:20b | No key needed | Local Ollama instance |

When a provider fails, Mercury automatically tries the next one. It remembers the last successful provider and starts there on the next request.

> **More providers incoming** — Google Gemini, Mistral, and others are on the roadmap. Mercury's OpenAI-compatible architecture also supports custom endpoints via base URL configuration.

## Architecture

- **TypeScript + Node.js 18+** — ESM, tsup build
- **Vercel AI SDK v4** — `generateText` + `streamText`, 10-step agentic loop, provider fallback
- **grammY** — Telegram bot with typing indicators, editable streaming, and file uploads
- **SQLite + FTS5** — Second brain with full-text search, conflict resolution, auto-consolidation
- **JSONL** — Short-term, long-term, and episodic conversation memory
- **Daemon manager** — Background spawn + PID file + watchdog crash recovery
- **System services** — macOS LaunchAgent, Linux systemd, Windows Task Scheduler

## License

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)

---

## Disclaimer

**This is AI - it can break sometimes, please use this at your own risk.**

---

## Suggestions and Contributions

For suggestions, contributions, or any inquiries, please reach out to us at [mercury@cosmicstack.org](mailto:mercury@cosmicstack.org).
