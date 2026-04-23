# Mercury — Decisions

> Architecture Decision Records. New ones appended as we go.

## ADR-001: TypeScript + Node.js

- **Context**: Need a runtime for 24/7 headless agent with future GUI, mobile, and chat integrations.
- **Decision**: TypeScript on Node.js.
- **Consequence**: Best AI SDK ecosystem (Vercel AI SDK), Ink for TUI, grammY for Telegram, easiest path to every future channel.

## ADR-002: Ink for TUI

- **Context**: CLI needs to feel alive — animations, progress, typewriter effects.
- **Decision**: Ink + React for terminal UI.
- **Consequence**: Steeper learning curve than Commander, but legendary UX. Initial CLI uses readline; Ink added in Phase 2.

## ADR-003: Flat-file memory

- **Context**: Memory needs to be simple, inspectable, git-friendly.
- **Decision**: JSONL for long-term/episodic, JSON for short-term.
- **Consequence**: Easy to debug, no DB dependency. May need SQLite later for semantic search.

## ADR-004: grammY for Telegram

- **Context**: Need Telegram integration with streaming and typing.
- **Decision**: grammY + @grammyjs/stream + @grammyjs/auto-retry.
- **Consequence**: Best TypeScript Telegram framework. Built-in streaming support. Active community.

## ADR-005: Vercel AI SDK for LLM

- **Context**: Multiple providers (OpenAI, Anthropic, DeepSeek) with streaming.
- **Decision**: Vercel AI SDK (`ai` package) with provider-specific adapters.
- **Consequence**: Unified API, built-in streaming, tool calling. Provider swaps are one-line changes.

## ADR-006: Soul as separate markdown files

- **Context**: Agent personality needs to be editable, versionable, and token-efficient.
- **Decision**: Four separate markdown files: soul.md, persona.md, taste.md, heartbeat.md. Only soul + persona injected every request; taste + heartbeat selectively.
- **Consequence**: ~350 token baseline for identity. Owner can edit personality without code changes.

## ADR-007: Agent Skills specification

- **Context**: Skills need to be modular, installable at runtime, and token-efficient.
- **Decision**: Adopt the Agent Skills spec (agentskills.io). Skills use `SKILL.md` with YAML frontmatter + markdown instructions. Stored in `~/.mercury/skills/`. Progressive disclosure: only name+description loaded at startup; full instructions loaded on invocation.
- **Consequence**: Skills are human-readable markdown, no code required. Token budget stays low. Install by pasting content or URL.

## ADR-008: Scheduler with YAML persistence

- **Context**: Mercury needs to set reminders, run periodic tasks, and trigger skills on a schedule.
- **Decision**: Expose `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` as AI-callable tools. Persist scheduled tasks to `~/.mercury/schedules.yaml`. Restore on startup. Tasks fire as internal (non-channel) messages through the agent loop.
- **Consequence**: Mercury can autonomously schedule work. Tasks survive restarts. Internal execution keeps scheduled tasks invisible to channels unless the agent explicitly sends output.

## ADR-009: Daemonization via Custom Hybrid Approach

- **Context**: Mercury runs 24/7 but only in foreground mode. Closing the terminal kills the process, breaking Telegram, scheduled tasks, and heartbeat. Non-technical users should not need to install PM2/forever/systemd scripts manually.
- **Decision**: Build a custom hybrid daemon manager natively into Mercury. No external dependencies. Uses three layers:
  1. **Background spawn** — `child_process.spawn({detached: true})` + PID file + log redirect. Activated via `mercury start -d`.
  2. **Watchdog** — Built-in crash recovery with exponential backoff (1s base, 1.25x, max 10 restarts/60s). Only active in daemon mode.
  3. **Platform service generators** — `mercury service install` detects OS and generates the appropriate config: `systemd --user` unit on Linux, `~/Library/LaunchAgents` plist on macOS, startup shortcut on Windows. No root needed on Mac/Linux.
- **Alternatives considered**:
  - `node-windows/mac/linux` trio — partially unmaintained, requires sudo on Mac, node-linux is dead
  - PM2 as dependency — 15MB, 50+ deps, AGPL-3.0 license
  - PM2 as user install — requires non-technical users to learn a separate tool
  - `forever` — officially deprecated by its own maintainers
  - Native detached only — no crash recovery, no boot startup
- **Consequence**: Zero external dependencies for core daemonization. Boot services are user-level (no sudo on Mac/Linux). Windows gets background mode + documented PM2 path. Foreground mode unchanged — daemon mode is opt-in. In daemon mode, CLI becomes log-only; Telegram (or other remote channels) is the interactive interface.

## ADR-010: Second Brain — SQLite-backed autonomous structured memory

- **Context**: Mercury needs a persistent user model that learns from conversations over time. The previous LongTermMemory (flat JSONL) is too simple — keyword-only search, no structure, no merge, no conflict handling, no tiering. A second brain was partially implemented (second-brain-db.ts for SQLite, user-memory.ts for JSON) but both were disconnected dead code.
- **Decision**: Build a unified second brain using SQLite (better-sqlite3) as the storage backend with the UserMemoryStore business logic layer. Key principles:
  - **Autonomous**: No review queue, no user approval. Memories are stored, merged, and de-conflicted automatically via confidence scores. Weak memories survive with low scores and decay naturally.
  - **Automatic conflict resolution**: When a polarity conflict is detected (e.g., "prefers X" vs "does not prefer X"), the higher-confidence memory wins silently. Equal confidence → newer wins.
  - **Automatic tiering**: Memory types like goals and projects start as `active` (time-bound); identity and preferences start as `durable`. Memories reinforced 3+ times are promoted from active to durable.
  - **Staleness pruning**: Active inferred memories not seen in 21 days are dismissed. Durable inferred memories with no reinforcement in 120 days have their confidence decayed; below 0.3 they are dismissed.
  - **Invisible to the user**: Memory extraction runs as a fire-and-forget background process after the response is sent. No tool calls in the agentic loop, no status messages. The user never waits.
  - **10 memory types**: identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection.
  - **FTS5 full-text search** for the `/memory search` command.
- **Alternatives considered**:
  - JSON-only (UserMemoryStore as-is) — good logic but no search, scales poorly
  - SQLite-only (SecondBrainDB as-is) — good storage but no merge/conflict/reflection logic
  - Vector embeddings — overkill for current scale, adds heavy dependency
- **Consequence**: SQLite with WAL mode gives fast reads for prompt injection (microseconds). FTS5 enables fast search. The business logic (merge, conflict, reflection, tiering, staleness) is inherited from UserMemoryStore. One native dependency (better-sqlite3). The user's only controls are: observe (overview, recent, search), pause/resume learning, and clear all.