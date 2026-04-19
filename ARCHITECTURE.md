# Mercury — Architecture

> Living document. Updated as the system evolves.

## Overview

Mercury is a soul-driven, token-efficient AI agent that runs 24/7. It communicates via channels (CLI, Telegram, future: Signal, Discord, Slack) and maintains persistent memory.

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
| Providers | Senses | `src/providers/` |
| Skills | Abilities | `src/skills/` |
| Channels | Communication | `src/channels/` |
| Heartbeat/scheduler | Circadian rhythm | `src/core/scheduler.ts` |
| Lifecycle | Awake/Sleep/Think | `src/core/lifecycle.ts` |

## Directory Structure

```
src/
├── index.ts          # CLI entry (commander)
├── channels/         # Communication interfaces
│   ├── base.ts       # Abstract channel
│   ├── cli.ts        # CLI adapter
│   ├── telegram.ts   # Telegram adapter (grammY)
│   └── registry.ts   # Channel manager
├── core/             # Channel-agnostic brain
│   ├── agent.ts      # Main think→act→respond loop
│   ├── lifecycle.ts  # State machine
│   └── scheduler.ts  # Cron + heartbeat
├── memory/           # Persistence layer
│   └── store.ts      # Short/long/episodic memory
├── providers/        # LLM APIs
│   ├── base.ts       # Abstract provider
│   ├── openai-compat.ts
│   ├── anthropic.ts
│   └── registry.ts
├── soul/             # Consciousness
│   └── identity.ts   # Soul/persona/taste loader
├── skills/           # Modular abilities
│   ├── types.ts
│   └── loader.ts
├── types/            # Type definitions
└── utils/            # Config, logger, tokens
```

## Agent Lifecycle

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                          ↓
                                            idle → sleeping → awakening → idle
```

## Token Budget

- System prompt (soul + persona): ~350 tokens per request
- Short-term context: last 10 messages
- Long-term facts: keyword-matched, ~3 facts injected
- Daily default: 50,000 tokens

## Channels

### CLI
- Ink-based TUI (Phase 2 — current CLI uses readline)
- `mercury start —mode cli`

### Telegram
- grammY framework + @grammyjs/stream for streaming
- Typing indicator while processing
- Proactive messages via heartbeat
- `TELEGRAM_BOT_TOKEN` in .env or mercury.yaml

## Configuration

- `.env` — API keys, tokens (gitignored)
- `config/mercury.yaml` — persistent config (saved by setup wizard)
- `soul/*.md` — personality markdowns (editable anytime)