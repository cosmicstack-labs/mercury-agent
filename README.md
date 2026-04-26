<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/card-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/card-light.png">
    <img alt="Mercury — Soul-Driven AI Agent" src="docs/card-light.png" width="600">
  </picture>
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
| **Web Panel** | Browser-based chat, status dashboard, auth token support, localhost by default |
| **Discord** | Slash commands, allowlist access control, deferred responses, minimal intents |

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
| **Z.ai (GLM)** | glm-5.1 | `ZAI_API_KEY` | OpenAI-compatible, Coding Plan endpoint opt-in |
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

## Contributing

We're open to contributions! Mercury is built to evolve, and we welcome help from the community. Whether it's fixing a bug, adding a tool, improving memory, or refining the soul — all quality contributions are appreciated.

### 🎯 Agentic Expertise — Must-Have for Contributors

Mercury isn't just another open-source project — it's a **soul-driven agent** that runs 24/7, manages permissions, remembers context, and interacts across channels. If you're contributing, you must think like an agent builder, not just a library contributor. These are non-negotiable principles every contributor should internalize:

| Principle | What It Means |
|-----------|---------------|
| 🧠 **Think in loops** | Mercury operates in a 10-step agentic loop. Your tool or feature will be called multiple times per conversation. Make it idempotent where possible. |
| 🔐 **Permission-first** | Every action that touches the outside world (files, shell, network, git) must go through the permission system. Never assume approval. |
| 💾 **Memory-aware** | If your feature generates facts about the user, consider hooking into the Second Brain. If it reads user data, check memory first. |
| 📏 **Token-conscious** | Mercury has a daily token budget. Logging, verbose outputs, and large context dumps burn tokens fast. Keep it lean. |
| 🔌 **Channel-agnostic** | Tools should work identically on CLI and Telegram. Don't assume a terminal, a keyboard, or even a human on the other end. |
| 🔁 **Graceful degradation** | If a provider fails, a tool errors, or a file doesn't exist — Mercury should recover, not crash. Always handle edge cases. |
| 📋 **Self-documenting** | Your tool's name and description are what Mercury reads to decide when to use it. Make them clear, specific, and action-oriented. |
| 🧪 **Test the loop, not just the function** | A tool that works in isolation may fail in the agentic loop (e.g., returns too much data, blocks the next step). Test end-to-end. |

### Code Quality — Dos

| Do | Why |
|----|-----|
| ✅ Write clean, readable TypeScript with explicit types | Mercury's codebase is type-safe — keep it that way |
| ✅ Add JSDoc comments on public functions and tools | Helps other contributors and the agent understand intent |
| ✅ Keep functions small and single-purpose | Easier to test, review, and reason about |
| ✅ Use async/await over raw promises | Consistent error handling and readability |
| ✅ Write tests for new tools and memory features | Reliability matters for a 24/7 agent |
| ✅ Follow the existing project structure (`src/tools/`, `src/memory/`, `src/channels/`) | Keeps the codebase navigable |
| ✅ Use the Agent Skills spec for new skill-based features | Ensures compatibility with the skills ecosystem |
| ✅ Document breaking changes in PR descriptions | Helps maintainers version properly |

### Code Quality — Don'ts

| Don't | Why |
|-------|-----|
| ❌ Don't add dependencies without discussion | Mercury is lean — every dep adds surface area |
| ❌ Don't hardcode API keys, tokens, or paths | Use config/env vars like the rest of the codebase |
| ❌ Don't bypass the permission system | Tools must ask before acting — that's Mercury's core promise |
| ❌ Don't introduce sync/blocking I/O in hot paths | Mercury is async-first for a reason |
| ❌ Don't commit large binary files or secrets | Use `.gitignore` and env files |
| ❌ Don't change the soul/persona system without discussion | It's the heart of Mercury — changes need care |
| ❌ Don't submit untested Telegram or daemon changes | These are hard to debug post-merge |
| ❌ Don't ignore the token budget system | Every tool should be mindful of token consumption |

### Getting Started

1. Fork the repo
2. Run `npm install`
3. Make your changes
4. Run `npm run build` to verify it compiles
5. Test with `mercury` locally
6. Open a PR with a clear description of what you changed and why

### PR Guidelines

- Keep PRs focused — one feature/fix per PR
- Include before/after behavior in the description
- Tag related issues if applicable
- Be responsive to review feedback

### Need Help?

Open an issue or reach out at [mercury@cosmicstack.org](mailto:mercury@cosmicstack.org). We're friendly.

---

## Community

1. **Discord** — [Join the Mercury Agent Discord](https://discord.gg/5emMpMJy5J) for real-time chat, support, and community discussions.
