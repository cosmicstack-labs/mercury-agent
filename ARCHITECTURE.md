# Mercury — Architecture

> Living document. Updated as the system evolves.

## Overview

Mercury is a soul-driven, token-efficient AI agent that runs 24/7. It is an **orchestrator**, not just a chatbot. It can read/write files, run commands, and perform multi-step agentic workflows — all governed by a strict permission system. It communicates via channels (CLI, Telegram, future: Signal, Discord, Slack) and maintains persistent memory.

## The Human Analogy

| Mercury Concept | Human Analogy | File/Module |
|---|---|---|
| soul.md | Heart | `soul/soul.md` |
| persona.md | Face | `soul/persona.md` |
| taste.md | Palate | `soul/taste.md` |
| heartbeat.md | Breathing | `soul/heartbeat.md` |
| Short-term memory | Working memory | `src/memory/store.ts` |
| Episodic memory | Recent experiences | `src/memory/store.ts` |
| Long-term memory | Life lessons | `src/memory/store.ts` |
| Second brain | Structured long-term user model | `src/memory/user-memory.ts` + `src/memory/second-brain-db.ts` |
| Providers | Senses | `src/providers/` |
| Capabilities | Hands & tools | `src/capabilities/` |
| Permissions | Boundaries | `src/capabilities/permissions.ts` |
| Channels | Communication | `src/channels/` |
| Heartbeat/scheduler | Circadian rhythm | `src/core/scheduler.ts` |
| Lifecycle | Awake/Sleep/Think | `src/core/lifecycle.ts` |

## Directory Structure

```
src/
├── index.ts              # CLI entry (commander)
├── channels/             # Communication interfaces
│   ├── base.ts           # Abstract channel
│   ├── cli.ts            # CLI adapter (readline + inline permission prompts)
│   ├── telegram.ts       # Telegram adapter (grammY)
│   └── registry.ts       # Channel manager
├── core/                 # Channel-agnostic brain
│   ├── agent.ts          # Multi-step agentic loop (generateText with tools)
│   ├── lifecycle.ts      # State machine
│   └── scheduler.ts     # Cron + heartbeat
├── capabilities/         # Agentic tools & permissions
│   ├── permissions.ts    # Permission manager (read/write scope, shell blocklist)
│   ├── registry.ts      # Registers all AI SDK tools + skill/scheduler tools
│   ├── filesystem/      # File ops: read, write, create, list, delete
│   ├── shell/           # Shell execution with blocklist
│   ├── skills/          # Skill management tools
│   │   ├── install-skill.ts
│   │   ├── list-skills.ts
│   │   └── use-skill.ts
│   └── scheduler/       # Scheduling tools
│       ├── schedule-task.ts
│       ├── list-tasks.ts
│       └── cancel-task.ts
├── memory/               # Persistence layer
│   ├── store.ts          # Short/long/episodic memory
│   ├── second-brain-db.ts # SQLite storage engine (FTS5)
│   └── user-memory.ts    # Second brain: autonomous structured memory
├── providers/            # LLM APIs
│   ├── base.ts           # Abstract provider + getModelInstance()
│   ├── openai-compat.ts
│   ├── anthropic.ts
│   └── registry.ts
├── soul/                 # Consciousness
│   └── identity.ts       # Soul/persona/taste loader + guardrails
├── skills/               # Modular abilities (Agent Skills spec)
│   ├── types.ts          # SkillMeta, SkillDiscovery, Skill types
│   ├── loader.ts         # SKILL.md parser, progressive disclosure
│   └── index.ts          # Barrel exports
├── types/                # Type definitions
└── utils/                # Config, logger, tokens
```

## Agentic Loop

Mercury uses the Vercel AI SDK's multi-step `generateText()` with tools:

```
User message → Agent loads system prompt (soul + guardrails + persona)
  → Agent calls generateText({ tools, maxSteps: 10 })
    → LLM decides: respond with text OR call a tool
      → If tool called:
        → Permission check (filesystem scope / shell blocklist)
        → If allowed: execute tool, return result to LLM
        → If denied: LLM gets denial message, adjusts approach
        → LLM continues (next step) — may call more tools or respond
      → If text: final response returned to user
  → Agent sends final response via channel
```

## Permission System

### Filesystem Permissions (folder-level scoping)

- Paths without scope = **no access**, must ask user
- User can grant: `y` (one-time), `always` (saves to manifest), `n` (deny)
- Manifest stored at `~/.mercury/permissions.yaml`
- Edit anytime — Mercury never bypasses

### Shell Permissions

- **Blocked** (never executed): `sudo *`, `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `shutdown`, `reboot`
- **Auto-approved** (no prompt): `ls`, `cat`, `pwd`, `git status/diff/log`, `node`, `npm run/test`
- **Needs approval**: `npm publish`, `git push`, `docker`, `rm -r`, `chmod`, piped `curl | sh`
- Commands restricted to CWD + approved folder scopes

### Inline Permission UX

When Mercury needs a scope it doesn't have:
```
  ⚠ Mercury needs write access to ~/projects/myapp. Allow? (y/n/always):
  > always
  [Scope saved to ~/.mercury/permissions.yaml]
```

## Tools

| Tool | Description | Permission Check |
|---|---|---|
| `read_file` | Read file contents | Read scope for path |
| `write_file` | Write to existing file | Write scope for path |
| `create_file` | Create new file + dirs | Write scope for parent dir |
| `list_dir` | List directory contents | Read scope for path |
| `delete_file` | Delete a file | Write scope, always confirms |
| `run_command` | Execute shell command | Blocklist + approval list + scope |
| `install_skill` | Install a skill from content or URL | No restriction |
| `list_skills` | List installed skills | No restriction |
| `use_skill` | Load and invoke a skill's instructions | No restriction |
| `schedule_task` | Schedule a recurring cron task | Validates cron expression |
| `list_scheduled_tasks` | List scheduled tasks | No restriction |
| `cancel_scheduled_task` | Cancel a scheduled task | No restriction |

## Agent Lifecycle

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                          ↓
                                            idle → sleeping → awakening → idle
```

## Runtime Data Location

All runtime data lives in `~/.mercury/` (not the project directory):

| What | Where |
|---|---|
| Config | `~/.mercury/mercury.yaml` |
| Soul files | `~/.mercury/soul/*.md` |
| Memory | `~/.mercury/memory/` |
| Skills | `~/.mercury/skills/` |
| Schedules | `~/.mercury/schedules.yaml` |
| Permissions | `~/.mercury/permissions.yaml` |

## Token Budget

- System prompt (soul + guardrails + persona): ~500 tokens per request
- Short-term context: last 10 messages
- Long-term facts: keyword-matched, ~3 facts injected
- Second brain: relevant user memories injected via `retrieveRelevant()` (~900 chars)
- Daily default: 50,000 tokens

## Second Brain

Mercury's second brain is an autonomous, persistent user model that learns from conversations over time. It is not a raw chat log and it is not a document dump. It stores compact, structured memories it believes may help in future conversations.

### How It Learns (Background, Invisible)

For each non-trivial conversation:
1. Mercury responds to the user normally.
2. After the response is sent, a background `extractMemory()` call extracts 0-3 typed memory candidates (preference, goal, project, etc.) using a separate LLM call (~800 tokens).
3. Each candidate goes through `UserMemoryStore.remember()` which:
   - Merges with existing memory if >= 74% overlap (strengthens evidence)
   - Auto-resolves conflicts (higher confidence wins, equal confidence → newer wins)
   - Auto-tiers: identity/preference → durable, goal/project → active
   - Promotes active → durable after 3+ reinforcing observations
   - Stores weak memories with low confidence — they decay naturally
4. On each heartbeat, Mercury consolidates (re-synthesizes profile/active summaries, generates reflections) and prunes (dismisses stale memories, promotes reinforced ones).

The user never sees or waits for this process. No tool calls are involved in the agentic loop.

### What It Does Not Store

- Greetings, small talk, filler
- Low-signal one-off details (below 0.55 confidence minimum)
- Speculative assistant guesses

### `/memory` Command

```
/memory        → Opens arrow-key menu (CLI) or sends overview (Telegram)

Menu:
  Overview          — total memories, breakdown by type, learning status
  Recent            — last 10 memories (type + summary + confidence)
  Search            — full-text search across all memories
  Pause Learning    — toggle: stop/resume storing new memories
  Clear All         — confirm, then wipes all memories
  Back
```

### User Controls

The second brain is autonomous in learning and management. The user's only controls are:
- **Pause/resume** learning (for sensitive conversations)
- **Clear all** memories (start fresh)
- **Observe** via overview, recent, and search

No review queue. No manual pinning. No manual conflict resolution. No manual editing.

## Channels

### CLI
- Readline-based with inline permission prompts
- `mercury start` or just `mercury`

### Telegram
- grammY framework + @grammyjs/stream for streaming
- Typing indicator while processing
- Proactive messages via heartbeat
- `TELEGRAM_BOT_TOKEN` in .env or mercury.yaml

## Skills System

Mercury supports the Agent Skills specification. Skills are modular, installable instruction sets that extend Mercury's capabilities without code changes.

### Skill Format

Each skill is a directory under `~/.mercury/skills/` containing a `SKILL.md`:

```
~/.mercury/skills/
├── daily-digest/
│   └── SKILL.md       # Required: YAML frontmatter + markdown instructions
├── code-review/
│   ├── SKILL.md
│   ├── scripts/       # Optional: executable scripts
│   └── references/    # Optional: reference documents
└── _template/
    └── SKILL.md       # Seeded template for new skills
```

### SKILL.md Structure

```markdown
---
name: daily-digest
description: Send a daily summary of activity
version: 0.1.0
allowed-tools:
  - read_file
  - list_dir
  - run_command
---

# Daily Digest

Instructions for Mercury to follow when this skill is invoked...
```

### Progressive Disclosure

- **Startup**: Only skill names + descriptions are loaded (token-efficient)
- **Invocation**: Full skill instructions loaded on demand via `use_skill` tool
- This keeps the system prompt small while making skills available

### Skill Tools

- `install_skill`: Install from markdown content or URL
- `list_skills`: Show all installed skills
- `use_skill`: Load and invoke skill instructions into agent context

## Scheduler

Mercury can schedule recurring tasks using cron expressions. Tasks persist to `~/.mercury/schedules.yaml` and are restored on startup.

### Scheduled Task Fields

| Field | Description |
|---|---|
| `id` | Unique task identifier |
| `cron` | Standard 5-field cron expression |
| `description` | Human-readable description |
| `prompt` | Text prompt to send to agent when task fires |
| `skill_name` | Optional: skill to invoke when task fires |
| `createdAt` | ISO timestamp |

### How Tasks Execute

When a scheduled task fires:
1. If `skill_name` is set, Mercury is prompted to invoke that skill via `use_skill`
2. If `prompt` is set, Mercury processes it as an internal (non-channel) message
3. Internal messages don't produce visible channel responses — they run silently in the agent loop

### Scheduler Tools

- `schedule_task`: Create a cron task with prompt or skill_name
- `list_scheduled_tasks`: Show all scheduled tasks
- `cancel_scheduled_task`: Remove a scheduled task