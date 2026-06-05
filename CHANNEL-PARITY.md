# Mercury — Channel Parity

> Living document. The contract that keeps every channel equally capable.

## Principle

No channel is more or less powerful than another at the agent boundary.
**Telegram is the reference feature set** — every channel must include all of
its features. Where a feature relies on a UI affordance a channel lacks (inline
buttons, message editing, token streaming), a **text-equivalent counts as
parity**.

Signal is intentionally **text-only**: no inline keyboards, no message editing,
no live streaming. Its parity substitute for streaming is **throttled progress
+ completion status messages**.

## The capability contract

The `Channel` interface (`src/channels/base.ts`) declares every method the agent
is allowed to call **without branching on the concrete class**. `BaseChannel`
provides conservative no-op defaults so a new channel is correct by default and
opts into richer behavior by overriding.

### Capability flags

| Method | Meaning | cli | web | telegram | signal | discord |
|---|---|:--:|:--:|:--:|:--:|:--:|
| `usesTaskBuffering()` | Buffers tool feedback into one live status card | ✗ | ✗ | ✓ | ✓ | ✓ |
| `supportsStreaming()` | Can stream model text token-by-token | ✓ | ✓ | ✓ | ✗ | ✓ |

The agent derives `canStream` from `channel.supportsStreaming()` (gated by the
Telegram streaming toggle) and routes task-lifecycle/completion through
`channel.usesTaskBuffering()` — never `instanceof`.

### Task lifecycle (no-op unless buffering)

`beginTask` · `endTask` · `isTaskActive` · `resetStepCounter` ·
`popDeferredResponse` · `cleanupEphemeralMessages`

### Progress & completion

`sendToolFeedback(toolName, args, targetId?)` ·
`sendStepDone(toolName, result, targetId?)` ·
`sendCompletion(elapsedMs, stepCount, targetId?, meta?)`

On buffering channels (Telegram, Signal, Discord) these update a single live status
message and the completion summary flushes the deferred response. On streaming
channels (CLI, Web) progress is rendered inline; `sendCompletion` is a banner
(CLI) or a no-op (Web).

### Interactive choice

`requestChoice(question, choices, targetId?) → Promise<string>`

- **CLI**: arrow-key menu.
- **Telegram**: inline keyboard with a callback handler.
- **Discord**: button components with interaction handler.
- **Signal**: numbered list + awaits a real numbered reply via `waitForReply`
  (the text equivalent of inline buttons). Accepts a number or the option label.
- **Default (Web / future channels)**: sends a numbered list and returns the
  first option.

> Before this contract, `presentChoice` sent Signal/Web a numbered list but
> returned `choices[0]` **without waiting for a reply** — Signal could not make
> an interactive choice. `requestChoice` closes that gap.

## Signal specifics

- Connects to a self-hosted `bbernhard/signal-cli-rest-api` container as a REST
  client; all comms happen in a dedicated Signal group named "Mercury".
- Never intercepts "Note to Self" or DMs.
- Identity matching accepts phone number **or** UUID (`matchesSignalIdentity`).
- `/access` shows the Signal access summary. `/status`, `/help`, `/permissions`,
  `/budget`, `/code`, `/memory`, `/spotify`, etc. flow through the same
  channel-agnostic `handleChatCommand` as Telegram. `/help` renders
  `getSignalHelp()`.
- Send resilience: `signalPost` retries with backoff; messages are throttled.

## Discord specifics

- Connects to Discord via `discord.js` Gateway (WebSocket); supports DMs, server
  text channels, and threads.
- DMs: always respond (parity with Telegram private chats).
- Server channels: configurable `requireMention` (default: true — only respond on
  @mention), `freeResponseChannels` (always respond), `ignoredChannels` (never respond).
- Auto-threading (`autoThread: true`): creates a thread on each @mention in a server
  text channel, then responds inside the thread — keeps channels clean.
- Rich UI via `EmbedBuilder`: status cards, completion banners, and memory overview
  use embeds with fields, colors, and timestamps.
- Interactive components: `askPermission` / `askToContinue` use buttons;
  `askPermissionMode` uses a **select menu** (dropdown); `requestChoice` uses buttons
  for ≤5 choices and a select menu for more.
- Slash commands: 15 registered via `ApplicationCommandManager` on startup; also
  parses `/command` in message text (hybrid approach).
- Reaction indicators (opt-in via `reactions: true`): 👀 on message receipt.
- `mdToDiscord()` converts markdown to Discord-compatible format (headings → bold,
  links → angle-bracket URLs, code blocks preserved).
- Message splitting at **2000 chars** (Discord limit) vs Telegram's 4096.
- Access control: same admin/member/pending model as Telegram, with Discord user
  IDs (Snowflakes). Pairing flow identical (pairing code → CLI approval).

## Guardrails

`src/channels/channel-parity.test.ts` structurally enforces the contract:

1. Every concrete channel exposes **all** contract methods (inherited counts).
2. Capability flags return the expected values per channel.
3. `BaseChannel` defaults are the conservative no-op values and never throw.
4. Default `requestChoice` sends a numbered list and returns the first option.

If a future channel regresses parity, these tests fail.
