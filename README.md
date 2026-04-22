<p align="center">
  <img src="docs/card.png" alt="Mercury — Soul-Driven AI Agent" width="600">
</p>

<p align="center">
  <strong>Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access.</strong>
</p>

<p align="center">
  Runs 24/7 from CLI or Telegram. 31 built-in tools. Extensible skills. Asks before it acts.
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

To reconfigure later (change keys, name, settings):

```bash
mercury doctor
```

## Why Mercury?

Every AI agent can read files, run commands, and fetch URLs. Most do it silently. **Mercury asks first.**

- **Permission-hardened** — Shell blocklist (`sudo`, `rm -rf /`, etc. never execute). Folder-level read/write scoping. Pending approval flow. Skill elevation with granular `allowed-tools`. No surprises.
- **Soul-driven** — Personality defined by markdown files you own (`soul.md`, `persona.md`, `taste.md`, `heartbeat.md`). No corporate wrapper.
- **Token-aware** — Daily budget enforcement. Auto-concise when over 70%. `/budget` command to check, reset, or override.
- **Multi-channel** — CLI with real-time streaming. Telegram with HTML formatting, file uploads, and typing indicators.
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
| **CLI** | Readline prompt, real-time text streaming, markdown rendering, file display |
| **Telegram** | HTML formatting, file uploads (photos, audio, video, documents), typing indicators, `/budget` commands |

### Telegram Pairing

Mercury uses a **single-owner pairing model** — only one Telegram account can be paired at a time.

- **Unpaired bots** only process `/start` or `/pair`. All other messages are ignored. This prevents unauthorized access.
- **To pair:** Send `/start` to your Mercury bot in a private chat. The bot records your user ID and chat ID.
- **To unpair:** Send `/unpair` to remove the pairing.
- Mercury only works in private (one-to-one) chats. Group messages are ignored.

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
| `~/.mercury/.env` | API keys and tokens (loaded alongside project .env) |
| `~/.mercury/soul/*.md` | Agent personality (soul, persona, taste, heartbeat) |
| `~/.mercury/permissions.yaml` | Capabilities and approval rules |
| `~/.mercury/skills/` | Installed skills |
| `~/.mercury/schedules.yaml` | Scheduled tasks |
| `~/.mercury/token-usage.json` | Daily token usage tracking |
| `~/.mercury/memory/` | Short-term, long-term, episodic memory |
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

- **TypeScript + Node.js 20+** — ESM, tsup build, zero native dependencies
- **Vercel AI SDK v4** — `generateText` + `streamText`, 10-step agentic loop, provider fallback
- **grammY** — Telegram bot with typing indicators and file uploads
- **Flat-file persistence** — No database. YAML + JSON in `~/.mercury/`
- **Daemon manager** — Background spawn + PID file + watchdog crash recovery
- **System services** — macOS LaunchAgent, Linux systemd, Windows Task Scheduler

## License

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)

---

## Disclaimer

**This is AI - it can break sometimes, please use this at your own risk.**

---

## Suggestions and Contributions

For suggestions, contributions, or any inquiries, please reach out to us at [support@cosmicstack.org](mailto:support@cosmicstack.org).
