# Release v1.1.13

## ☿ Mercury Agent v1.1.13 — Chatty Mercury

Three new channels — Discord, Slack, and Signal — bring Mercury to where you already are. Every new channel has its own access model (pairing codes, admin roles, member approval), streaming responses, and real-time task progress. Signal adds end-to-end encryption for the privacy-first crowd.

Beyond channels, this release fixes the long-running cycle problem — the silent task failures that could make Mercury disappear mid-task. The CLI now updates heartbeats in-place instead of stacking new messages, step logs collapse to 3 lines (Ctrl+D for full history), and a crash flag system means Mercury tells you what happened when it restarts after an ungraceful exit.

### What's New

- **Discord** — Full bot integration with slash commands, streaming responses, rich embeds, organization access with admin roles and pairing codes, DM + channel support, and rate limiting.
- **Slack** — Socket Mode bot (no public endpoint needed) with slash commands, streaming edits, organization access with admin/member roles, channel + DM support, and @mention awareness.
- **Signal** — End-to-end encrypted via signal-cli bridge. Group and private modes. Auto-managed signal-cli binary. Pairing-code access control. Phone number redaction in CLI.
- **Crash recovery** — Crash flag system writes to `~/.mercury/.crash-flag` on ungraceful exit; next startup reports what happened.

### Fixed

- **CLI heartbeat updates in place** — No more wall-of-progress messages during long tasks.
- **All 12 silent task failure paths eliminated** — Every loop condition, tool limit, and stall now sends an explicit error message.
- **Step log collapse** — Max 3 visible steps during active tasks; Ctrl+D for full history.
- **Ollama Local routed through OpenAI compat** — Fixes AI SDK v1 specification error.
- **Daemon graceful shutdown** — SIGTERM → wait → SIGKILL; stale signal-cli cleanup on stop.
- **Channel send errors logged** — No more silently swallowed send failures.

### Dependencies

- `discord.js` v14.26.4
- `@slack/bolt` v4.7.3

### Upgrade

**npm:**
```
npm install -g @cosmicstack/mercury-agent@1.1.13
mercury restart
```

**Standalone binary:** re-run the one-line installer from [mercuryagent.sh](https://mercuryagent.sh), then:
```
mercury restart
```

No config migrations needed. All new channels are off by default.

### Files Touched

- `src/channels/discord.ts` — Discord channel (new)
- `src/channels/signal.ts` — Signal channel (new)
- `src/channels/slack.ts` — Slack channel (new)
- `src/signal/binary.ts` — signal-cli binary management (new)
- `src/signal/jsonrpc.ts` — JSON-RPC client (new)
- `src/signal/process.ts` — Process lifecycle (new)
- `src/signal/setup.ts` — Signal registration (new)
- `src/core/crash-flag.ts` — Crash flag system (new)
- `src/core/agent.ts` — Channel registration, heartbeat in-place, silent failure elimination
- `src/channels/registry.ts` — Discord/Slack/Signal registration
- `src/channels/cli.ts` — sendHeartbeat method
- `src/types/channel.ts` — Signal/Discord/Slack access types
- `src/utils/config.ts` — Config sections and access management for new channels
- `src/index.ts` — CLI commands for new channels, onboarding flows
- `src/cli/daemon.ts` — Graceful shutdown, signal-cli cleanup
- `src/cli/watchdog.ts` — Crash flag on max-restart
- `src/providers/registry.ts` — ollamaLocal → OpenAI compat
- `src/ui/App.tsx` — Step collapse, Ctrl+D, Processing indicator
- `package.json` — v1.1.13, discord.js, @slack/bolt

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v1.1.12...v1.1.13