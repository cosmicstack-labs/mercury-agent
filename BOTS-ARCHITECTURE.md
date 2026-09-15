# Mercury Bots — Research & Architecture

> Status: design proposal (pre-implementation). Branch `Mercury-bots`.
> Research basis: Hermes Agent (Nous Research), OpenClaw, Grok-on-X (`xai-org/grok-prompts`), production messaging-bot/queue patterns, and a full audit of Mercury's current architecture (Sept 2026).

---

## 0. What this is

Mercury Bots adds a second kind of agent to Mercury Code, alongside the main conversational agent:

- **Bots are persistent, persona-scoped specialists.** A marketing bot, a research bot, a publishing bot — each with its own character, own model/provider, own scoped memory, own tool permissions. A bot "acts as" its specialty and nothing else.
- **Bots are near-zero-interaction.** They never prompt the user mid-run. Everything they need (persona, scopes, memory access, communication links, schedules) is configured once at setup; at runtime they run fully automatic and **fail closed** (a permission they don't have is a denial, not a question).
- **Bots never block the main agent.** The Mercury core stays available while bots run. Bots execute as decoupled async work in the same process — not one thread/process per bot — so they respect low-end hardware (Termux, Raspberry Pi, small VPS).
- **Bots are configured at creation and composable afterwards.** Two bots can be linked (research bot feeds the publishing bot), memory access is opt-in per bot, and inter-bot communication is an explicit configured capability.
- **Bots are reachable everywhere Mercury is**: the `/bots` command in the TUI, the local HTTP API (Hono), Mercury Cloud (WS relay), and messaging channels (Telegram first).

---

## 1. Research summary

### 1.1 How the competitors do it

| Aspect | Hermes Agent (Nous) | OpenClaw | Grok on X |
|---|---|---|---|
| Unit of isolation | **Profile = whole home** (`~/.hermes/profiles/<name>/`: `SOUL.md`, `config.yaml`, `.env`, memory, sessions, cron) | **Agent entry inside one Gateway process** (own workspace, own SQLite store, per-agent tool allow/deny) | Versioned Jinja **system-prompt templates** per surface, additive over a base prompt |
| Execution model | N gateway processes, or one multiplexing process, or Desktop's **warm pool (max 3, ~60 MB each, 10-min idle reap, 30s slot wait)**; subagents on a thread pool (max 3 default) | **In-process, pure TS + promises, no worker threads**; RPC returns `{runId, accepted}` then streams; **lane-aware FIFO queue** (per-session lanes + global lane `max(8, cpus*4)`, separate `cron`/`subagent` lanes) | Server-side queueing; replies async, decoupled from user session |
| Memory | Per-profile by construction; shared only via external memory-provider plugins; subagents **blocked from memory**; write-approval staging | Per-agent by default; cross-agent search removed; sharing explicit (`extraPaths`, wiki vaults) | Static prompt constraints; no long-term memory on X surface |
| Bot↔bot comms | `message_agent(target, message)` fire-and-forget with attribution + delivery receipts (`queued→settled`) + typed failure codes; group rooms (2–6 bots, ≤10 msgs / ≤3 rounds, `[SILENT]` tokens) | No free-form DMs; deterministic bindings + coordinator→specialist delegation (`subagents.allowAgents`) | N/A (single bot) |
| Sandboxing | 8-layer defense; approvals **fail closed** (timeout = deny); dangerous-command regexes + hardline patterns that survive `--yolo`; container backends skip checks (container is the boundary) | Per-agent `tools.allow`/`tools.deny`; sandbox modes `off/non-main/all` with `shared/agent` scope; "deny can't be re-enabled by sandboxing"; candid: "Gateway process always stays on the host" | Hard output caps, no-markdown-on-X, language matching, never tag-spam reply target |
| Scheduling | First-class cron: `jobs.json`, every run = fresh agent, execution history DB (`claimed→running→completed/failed/unknown`), `wakeAgent` gate scripts skip the LLM when nothing changed | Embedded cron runs on dedicated `cron` lanes | Grok Tasks/Automations: pausable/resumable/editable **with run history retained**; limitation: one-shot prompts, no multi-step branching |
| Never-fail | Stale-PID recovery; delegation explicitly **not durable** (restart cancels children) | Input persisted to SQLite before ack; per-run `activeWriterRunId` verified on every transcript append; in-memory queue not replayed on restart | Load-shedding (mentions silently dropped under load — the failure mode we must avoid) |

### 1.2 What the distributed-systems evidence says

- **No broker.** The convergent single-machine design puts the durable queue **in the DB you already have** (SQLite lease-queue with heartbeats / Postgres `SKIP LOCKED`). Enqueue is transactional with state writes; expired leases auto-requeue work from crashed workers.
- **Low-end hardware verdict:** a Node `child_process` is a full V8 instance (~30–70 MB RSS). A 4 GB Pi fits 1–5 Node processes. The winning pattern is **one process, many agents as async tasks**; `worker_threads` only when true CPU parallelism is needed. Process-per-agent loses.
- **Supervisor ≠ retries.** Retries are policy for *calls* (backoff + caps); supervision is policy for *processes* (unconditional restart, throttled, with exit-code semantics so intentional exits don't crash-loop — an OpenClaw production incident ran 2,972 restarts without this).
- **Failure-type-aware retries:** transient (429/timeout → exponential backoff + jitter) vs permanent (invalid input, permission denial, suspected prompt injection → straight to a replayable DLQ, never re-queued).
- **Idempotency keys** on every event and every side-effecting tool call, checked *before* the LLM call.
- **Every run is an inspectable record** (Grok's automations model): no fire-and-forget anywhere.
- Empirical ceiling on single-loop agents: hundreds of "I/O-bound" LLM agents still degrade one event loop (per-response CPU work accumulates) → the fix is *bounded concurrency*, not more processes. For Mercury's realistic scale (≤ dozens of bots), in-process + concurrency caps is correct.

### 1.3 What Mercury already has (audited Sept 2026)

- **Runtime**: single Node process; main loop is a **strictly serial queue** (`Agent.processQueue`, one `handleMessage` at a time, `src/core/agent.ts:1339`). Sub-agents (`SubAgent`, `src/core/sub-agent.ts`) already run as in-process coroutines — but share the main `CapabilityRegistry`/`PermissionManager` and hardcode `providers.getDefault()`.
- **Config**: `~/.mercury/mercury.yaml` + per-concern YAML files (`permissions.yaml`, `schedules.yaml`); soul files as markdown (`src/soul/`); `subagents:` config block is the schema precedent for a `bots:` block.
- **Memory**: `UserMemoryStore` (SQLite second-brain, FTS5) already parameterizes `userKey` and `dbPath` (`src/memory/user-memory.ts:95`) → per-bot scoped memory is nearly free.
- **Permissions**: `PermissionManager` with path-scoped manifests, `tempScopes`, per-context approval maps (`src/capabilities/permissions.ts`); web/cloud-originated requests already never inherit local allow-all — the exact isolation rule bots need.
- **Scheduling**: `node-cron` Scheduler with persisted manifests (`~/.mercury/schedules.yaml`); autonomous execution exists as **internal messages** (`processInternalPrompt`, auto-approved, silent).
- **Channels & surfaces**: grammY Telegram channel; Hono HTTP server (`src/web/server.ts`) with API modules; Mercury Cloud WS client with `agent.command` envelope **and an existing `agent.message.relay`** (agent-to-agent relay through the cloud).
- **Durability today**: WorkLedger (per-message work keys + retries), crash-flag + continuation on restart, background-task manager (child-process shells + agent tasks), stall-watchdog + memory governor.
- **Commands**: three hardcoded if/else command layers (CLI commander, agent slash commands incl. fast-path, pure-TUI). No `/bots` anywhere yet.

---

## 2. Architecture

### 2.1 The bot primitive: `~/.mercury/bots/<botId>/`

A bot is a **profile directory + a runtime**, mirroring Hermes' "bot = profile" primitive but executed OpenClaw-style (in-process lanes). On disk:

```
~/.mercury/bots/<botId>/
├── bot.yaml          # machine config: model, provider, tools, memory, comms, schedules, ingress
├── persona.md        # character + standing instructions (the "SOUL.md")
├── permissions.yaml  # per-bot scope manifest (path scopes, allow/deny tool lists)
└── .env              # bot-owned credentials (chmod 600) — never inherited by other bots
```

`bot.yaml` (schema mirrors the `subagents:` config precedent):

```yaml
id: researcher
name: "Research"
description: "Deep research specialist"
persona: persona.md            # file, like soul files
enabled: true
model:
  provider: anthropic          # optional; unset = inherit main default
  model: claude-sonnet-5
tools:
  allow: [web_search, fetch, read_file, memory_read, bot_send]
  deny: [shell, write_file, git_commit, delete_file]   # deny always wins
memory:
  scope: own                   # own | shared-read | none
  sharedPaths: []              # opt-in reads into other bots' memory dirs
  allowCrossBotRecall: [publisher]   # which bots' context this bot may search
comms:
  canMessage: [publisher]      # roster; also injected into system prompt
  groups: [growth]             # optional multi-bot rooms
schedules:                     # optional recurring routines
  - cron: "0 9 * * *"
    prompt: "Scan RSS sources and post findings to @publisher"
    deliver: bot-chat
autonomy:
  maxConcurrent: 1
  maxSteps: 25
  dailyTokenBudget: 200000     # hard cap; exceeded → pause, not die
```

**Persona is a markdown file, not config** (Grok's prompts are literally versioned templates; Hermes/OpenClaw both use markdown persona files; Mercury already does this for soul). `persona.md` holds character, voice, standing instructions, output conventions for each surface the bot serves.

### 2.2 Execution model — the decision

**Chosen: in-process async coroutines with a bot lane queue. No per-bot processes, no per-bot threads.**

Rationale (from §1.2): on Termux/Pi, per-bot V8 processes are unaffordable; Mercury's scale is dozens of bots, not thousands; and the main-agent non-blocking requirement is satisfied by *not routing bots through `Agent.processQueue`* — a separate `BotManager` runs each bot as its own coroutine loop with bounded concurrency, exactly like `SubAgent` does today but with full isolation of state (fixing sub-agents' two known blockers):

1. **Per-bot model**: resolve `provider/model` from the registry per bot (`getModelInstance()` already supports this; only `sub-agent.ts:160`'s `getDefault()` hardcode was the blocker).
2. **Per-bot registries**: each bot gets its **own** `CapabilityRegistry` + `PermissionManager` instances constructed from its manifest — no shared mutable cwd/channel-context swapping like `SubAgent` does (`sub-agent.ts:155–163`).

Concurrency budget: global bot lane capped at `max(2, cpus − 1)` concurrent bot turns (reuses `resource-manager.ts` semantics; per-bot `maxConcurrent` further limits). A queued bot turn waits; it does **not** block the main loop, and the main loop's LLM calls are never starved (bot lane shares only the event loop, and both sides are I/O-bound in practice).

**Escape hatch for later**: the `BotRuntime` interface is deliberately process-agnostic. A bot whose `autonomy.isolation: process` (P2) would run in a `worker_thread` for crash containment — the queue/manifest design doesn't change. This mirrors Hermes' warm-pool option without paying for it now.

### 2.3 Runtime shape

```
ChannelRegistry ── ingress (TUI /bots, HTTP API, Telegram, Cloud relay)
        │
        ▼
   BotIngress  ── validates + dedupes (idempotency key) + enqueues ──►  BotQueue (SQLite, lease-based)
        │
        ▼
   BotManager (own coroutine loop per enabled bot; global concurrency lane)
        │
        ▼
   BotTurn  = one run of one bot:
     fresh context per turn + persona.md + scoped memory injection + tool map
     (AI SDK streamText/generateText, same provider layer as main agent)
        │
        ├── BotBus ──► in-process mailbox delivery to other bots (+ Cloud relay off-host)
        ├── Scheduler ──► cron-triggered internal bot turns (separate cron lane)
        └── BotJournal ──► every run recorded (input, steps, outcome, cost) — inspectable
```

Components:

- **`BotManager`** (mirrors `SubAgentSupervisor`, `src/core/supervisor.ts`): owns lifecycle, restarts, concurrency lane, health. Registered with `BackgroundTaskManager` as `type: 'agent'` tasks so `/bg list`, the TUI status bar, and `/bots` all show live bots.
- **`BotQueue`**: durable job store at `~/.mercury/bots/queue.*` with a **pluggable backend chosen by capability probe at startup** (see §2.11): better-sqlite3 (native) → sql.js (WASM) → JSON-file lease store. Logical schema is backend-agnostic: `jobs (id, bot_id, source, payload, idempotency_key UNIQUE, state pending|claimed|running|done|dead, lease_expires_at, attempts, created_at)` + DLQ view. Claim = pending-scan with a 60s heartbeat lease; expired leases auto-requeue; `attempts >= cap` (transient) → `dead` (inspectable/replayable). Enqueue happens in the same atomic commit as any state write that motivated it.
- **`BotBus`**: in-process mailboxes. `bot_send(target, message)` delivers fire-and-forget with attribution prefix + delivery receipt (`queued → delivered → settled`) and typed failure codes (`target_disabled`, `queue_full`, `busy_timeout`) — Hermes' `message_agent` semantics. Cross-instance delivery rides the **existing Cloud `agent.message.relay`** (`src/index.ts:3113`), so bot↔bot works Mercury-Cloud-to-Mercury-Cloud too.
- **`BotJournal`**: append-only run records at `~/.mercury/bots/<id>/journal.jsonl` — every turn's input source, transcript path, outcome, token cost, failures. Grok's "every run is an inspectable record" rule; also our audit trail.
- **Wake-ups**: `Scheduler` manifests gain a `botId` field; a scheduled bot routine enqueues a bot turn on the **cron lane** (never the reply lane). Optional `gateScript` (Hermes `wakeAgent` idea): a cheap check that skips the LLM entirely when nothing changed.

### 2.4 Memory scoping (configured at bot setup)

`UserMemoryStore` already takes `userKey` and `dbPath` (`src/memory/user-memory.ts:95`) — bots get **their own `user_key` per bot id** in the second-brain DB (or a private DB path for strict isolation). Configurable at creation:

- `memory.scope: none` → no memory injection at all; the bot is stateless between turns (pure function of its persona + task).
- `own` (default) → the bot reads/writes only its own memory namespace. Injection mirrors the main agent's site (`agent.ts:2067`), with the bot's `userKey`.
- `shared-read` → additionally **read-only** access to listed shared paths / other bots' namespaces (`allowCrossBotRecall`), enforced in the store, not by prompt.
- Write path: bot memory writes are allowed by default but **rate/size-capped**, and can be configured to require owner approval at review time (staged writes surfaced via `/bots memory pending`) — never by interrupting a run.

Cross-bot *context sharing* (the research-bot → publisher-bot case) is **not** memory sharing: it's `bot_send` with a structured payload or a shared artifact written to the shared workspace dir. Memory access stays minimal by default.

### 2.5 Sandboxing & permissions (fail-closed, no mid-run prompts)

Bots get their **own** `PermissionManager` seeded from `bots/<id>/permissions.yaml`:

- **Tool allow/deny**: `tools.deny` always wins (OpenClaw rule: deny can't be re-enabled). Default-deny for destructive tools (`shell`, `write_file`, `delete_file`, `git_commit`) unless explicitly allowed at setup.
- **No interactive approval for bots, ever.** A permission prompt inside a bot turn is auto-resolved **deny** and journaled (`auto_deny` reason code). This is Hermes' fail-closed rule applied to a non-interactive worker. The owner sees denials in `/bots <id> journal` and can widen scopes at setup/review time.
- **No allow-all inheritance**: a bot can never inherit the session's allow-all mode — mirrors and extends the existing `isGlobalAutoApproveActive` rule that web/cloud requests don't inherit local allow-all.
- **Path scopes**: bot file access is scope-based like the main agent's manifest, defaulting to the bot's own dir + explicitly granted workspace paths. `cwdOnly`-style escape gates apply.
- **Dangerous-pattern denylist** reused from the main permission system for any allowed shell (plus the hardline set that survives every mode).
- **Budgets as security**: per-bot `dailyTokenBudget` and turn caps are hard stops (pause + journal, resume next window), protecting low-end devices and wallets from runaway loops.

### 2.6 Never-fail contract

Inherited from Mercury's "always uses a solution" ethos, hardened:

1. **Durable enqueue before ack** — every bot trigger (message, cron, API, relay) is persisted in the queue before the ingress acknowledges.
2. **Lease-based claiming** — crashed turns are requeued when their lease expires; no work is lost to a crash.
3. **Failure-typed retries** — transient failures (provider 429/timeout) retry with backoff + jitter, cap 3; permanent failures (invalid input, permission denial, prompt-injection suspicion, context exhaustion after one compaction retry) go **straight to the DLQ** — never re-queued.
4. **Restart semantics with exit codes** — `BotManager` restarts disabled-crash bots unconditionally but throttled (e.g., 15s min backoff, ×2 up to 15 min), and *intentional* states (`disabled`, `removed`, config error) stop restarts — the OpenClaw crash-loop lesson.
5. **Idempotency** — every trigger carries an idempotency key (source + event id); duplicates are dropped at enqueue.
6. **Run journal + DLQ inspection** — `/bots <id> journal`, `/bots <id> dlq`, `/bots <id> replay <jobId>`. Nothing fails silently.
7. **Graceful shutdown** — SIGINT/SIGTERM: stop intake, finish or lease-release in-flight turns, confirm offsets; restart resumes from the queue.

### 2.7 Surfaces

| Surface | How |
|---|---|
| **TUI** | New `/bots` slash command (fast-path, like `/agents`) → interactive panel: list bots (live states), onboard (guided, fully automatic config generation), edit config/persona, view journal, enable/disable, send a message. Also a TUI page in `cli.ts` command layer. |
| **Local HTTP API** | Hono module `src/web/api/bots.ts`: `GET /api/bots`, `POST /api/bots` (onboard), `GET/PATCH/DELETE /api/bots/:id`, `POST /api/bots/:id/message` (enqueue; returns job id), `POST /api/bots/:id/enable|disable`, `GET /api/bots/:id/journal`, `POST /api/bots/:id/replay`. Auth: existing web auth + attach token. |
| **Mercury Cloud** | `agent.command` envelope gains `bot.*` command types (list, message, configure) — same pattern as existing `model.select`/`task.stop`; cross-instance bot↔bot via `agent.message.relay`. |
| **Telegram (first channel)** | Ingress adapter: configured per bot or globally (`bots.channels.telegram`), `@botname` mention or `/bot <name>` routing in the existing grammY channel; bot replies stream back through the channel. Pairing/allowlist rules inherited from the channel's existing access control. |
| **Webhooks (P1)** | Generic inbound webhook route on the Hono server (`POST /api/bots/:id/hooks/<hook>`) with HMAC verification + dedupe → enqueue. |

### 2.8 Onboarding flow (`/bots onboard`)

Zero-prompt at runtime means **most of the effort goes into setup**, which stays interactive (it's the one designed human moment):

1. Name + one-line specialty → 2. persona: pick a template (marketing, research, publisher, custom) and edit `persona.md` → 3. model/provider (inherit or pick) → 4. tools: template presets + toggles; deny list explicit → 5. memory scope → 6. comms: pick linkable bots, direction arrows → 7. schedules (optional) → 8. budgets. Result: validated `bot.yaml` + persona.md + permissions.yaml; bot enabled immediately (or saved disabled). A bot can also be created fully non-interactively via `mercury bots create --from bot.yaml` or the HTTP API (Cloud path).

### 2.9 What a bot turn reuses

Same primitives as the main agent, isolated per bot: provider registry (per-bot model), AI SDK streaming loop, capability tools (own registry instance), skill loading (bot can be granted a skill allowlist), memory injection (own namespace), internal-message pattern for autonomous execution (from `processInternalPrompt`), task board for cross-bot shared state, background-task visibility.

### 2.10 Retention & disk budget — nothing grows forever

A bot fleet is six growing stores per bot (queue DB, journals, transcripts, mailboxes, DLQ, memory). Rule: **every store has a hard cap + retention window enforced at write time**, never a cleanup cron you forget.

| Store | Policy (default) | Enforced |
|---|---|---|
| Run transcripts | Keep full transcripts for the **last 50 runs/bot**; older evicted — safe because the journal is the permanent compact record | At run completion |
| Journal | Rotate at 5 MB, keep 3 rotations (~15–20 MB/bot lifetime bound) | At write |
| Queue | Completed jobs deleted **in the same transaction** as the journal write; pending backlog capped at 100/bot (refuse with `queue_full`) | Per claim/settle |
| DLQ | Cap 100 entries, oldest evicted **with a notification on eviction** | At enqueue |
| Mailboxes | Delivered messages purged 72h after receipt settles | Heartbeat sweep |
| Bot memory | Per-bot record/char caps + consolidation (Hermes' `MEMORY.md` budget pattern) + second-brain staleness machinery | At write |
| Bot artifacts (files) | Scoped workspace dir, 500 MB quota, LRU eviction of temp artifacts | At write |

Plus: **SQLite hygiene** (WAL + periodic idle `wal_checkpoint(TRUNCATE)` + scheduled incremental vacuum — the queue is the classic churn/bloat table; native backend only — the sql.js/JSON backends instead get commit-flush + file compaction on rotation); **disk-aware degradation** (free-space check at startup/heartbeat; below ~500 MB → pause cron lanes, journal-only transcript mode, notify owner once — degrade appetite, never fill the disk); **visibility** (`/bots storage` usage table + `bots.retention:` config block + `mercury bots prune --older-than 30d`); all consistent with existing Mercury precedent (background-task records pruned after 1h; second-brain staleness movement).

Net: a bot running hourly for a year costs tens of MB; a 10-bot fleet stays under ~200 MB before pruning.

### 2.11 Devices without native SQLite (old Node versions, Termux)

`better-sqlite3` is a native module: on unsupported Node versions or Termux/Android it may fail to install or load. Mercury already handles this exact problem for the second brain (optionalDependency + tmp-dir runtime probe, `src/memory/second-brain-db.ts:19-25`; `sql.js` ships as a regular dependency). Bots follow and extend the pattern:

**Backend chain (probed once at `BotQueue` init, logged):**
1. **better-sqlite3** (native, WAL, synchronous, fastest) — default when the probe passes.
2. **sql.js** (WASM SQLite, pure JS, zero native compilation, works on any Node ≥ 12 and every Termux) — slower (whole-DB-in-memory, flush-to-disk on commit), but the same SQL schema, same leases, same DLQ semantics.
3. **JSON-file lease store** (`queue.json` + atomic tmp-rename + `fsync`, the `SessionRepository` style) — zero-dependency last resort.

**Correctness never depends on SQLite.** The design deliberately requires nothing native SQLite uniquely provides: the queue has a **single writer** (the in-process `BotManager`), so `SKIP LOCKED`-style concurrency is unnecessary — what the design actually needs is *durability* (atomic rename + fsync gives that on any filesystem) and *lease expiry* (pure timestamp logic). SQLite buys speed and indexed state queries, not correctness. What degrades without it is bounded and cosmetic:
- FTS-based journal/search queries → keyword-scan fallback (small datasets after §2.10 caps).
- Throughput: the WASM/JSON backends are 2–10× slower on writes — irrelevant at bot scale (tens of jobs/hour, not thousands/second).
- `bots storage` and `doctor` report which backend is active, so degraded devices are visible, not silent.

**Bot memory** gets the same treatment: instead of the second brain's current hard requirement on native SQLite (it fails with a build hint today), a bot's scoped memory store falls back to sql.js, then to a JSONL-backed store implementing the same interface — bots must work everywhere the main agent works.

**Build/packaging guard:** `npm install` must never hard-fail on devices without a compiler — `better-sqlite3` stays in `optionalDependencies` (verify this stays true), and any install script failure is non-fatal. CI gains a job running the bot test suite with the native dep *removed*, so the fallback chain is exercised on every change — the same discipline as testing wire shapes per provider.

---

## 3. UX design (researched: Hermes Desktop, OpenClaw Control UI, Grok Automations, Claude Code/Codex/Aider conventions + full audit of Mercury's TUI/web)

### 3.1 Steal-list — what the best products converged on

1. **Roster as chat-app list, not admin table** (Hermes): avatar that doubles as live status (animates during a turn), last-message preview, timestamp, "needs you" badge. Presence = **last activity** (Hermes counts "wrote within 90s" / recent heartbeat), not connection status.
2. **Canonical "forever chat" per bot, born with the bot** (Hermes + Grok both converge): every run's results land in the bot's own thread; `/new`/`/reset` inside a bot chat are rerouted to `/compact` so the relationship can't be destroyed by accident. Run = **resumable thread** (Grok: clicking a run opens the transcript and you can continue it).
3. **CI-style runs list per bot** (Grok's "4 Succeeded / 2 Upcoming" + Overview/Runs tabs; Hermes' `cron runs` attempt ledger `claimed → running → completed/failed/unknown`): title-plus-summary rows, drill-down to full transcript.
4. **A `doctor`-style read-only fleet health check** (Hermes `cron doctor`): groups failed runs, failed *deliveries* (output produced but never delivered), silently-not-firing schedules (15-min grace), dead jobs — **with a meaningful exit code** (1 = actionable, 0 = healthy).
5. **Background completions have a guaranteed delivery target** (OpenClaw shipped `target: "none"` as default and users never learned tasks finished — a silent data-loss bug): completion of a routine/cron run always delivers somewhere (bot chat minimum), never vanishes.
6. **Push only decision-requiring events** ("needs you" badge = escalation primitive: @user mentions, approvals, failures with reason codes); everything else waits in the timeline. Quiet acks suppressed (OpenClaw drops ≤300-char `HEARTBEAT_OK`).
7. **Stream, never bare spinners** (Codex's 20-min bare spinner was a top complaint): elapsed timer + latest-activity line for anything >seconds. **Lossless interruption**: stop keeps partial output (Aider/Claude Code rule).
8. **Approvals must be un-hideable** (Claude Code bug family #60644: prompts rendered behind a transcript viewer sat invisible forever; OpenClaw bug: `/approve` queued behind the blocked run): approval/escalation surfaces render in a layer nothing can cover, and resolver commands bypass queues.
9. **Layer-naming error cards** (Hermes): name which layer failed (provider/auth/streaming/disk) with actions Retry / Switch provider / Open logs / Copy details. In chat channels, name the gate-level reason only (`[reason: provider_rate_limit]`), hide internals behind a verbose flag.
10. **Chat transport discipline** (Telegram/Slack research): typing indicator re-sent every ~4s, non-throwing; chunking at 4096 *code points* (not UTF-16 length) with paragraph→sentence→word fallback and frozen chunk boundaries; multi-bot attribution **allowlisted at a router chokepoint** (never pass agent-written identity fields through — spoofing vector); filter out a bot's own messages to prevent loops; remove loading indicators on every exit path including errors.

### 3.2 Mercury bot screens (TUI)

The `/bots` family maps onto audited primitives (all refs from the Sept 2026 UX audit):

| Screen | Renders with | Status |
|---|---|---|
| **Roster** (`/bots`) | New `BotsBody` in `mode: 'bots'` — windowed list-with-cursor panel per `GitPanel`/`ExplorerPanel` pattern; `STATUS_ICONS` (🔵 pending 🟢 running 🟡 paused ✅ completed ❌ failed ⛔ halted); each row: persona avatar/emoji, live state, last-message preview, last-run time, `⚠ needs-you` badge | New panel, new AppMode |
| **Bot chat** (`/bots <id>`) | The existing chat body with a segmented transcript — reuses streaming pipeline, `ToolCallCard`, markdown renderer verbatim | Reuse + transcript scoping |
| **Runs view** (`/bots <id> journal`) | `PlanProgressView`-style checklist (`☑ ▶ ☐`) summarizing recent runs + drill-down rows (run id, trigger, outcome, tokens, duration) | New, composed |
| **Run detail** (journal → Enter) | Transcript view via existing `Ctrl+O`-style transcript-viewer pattern; run resumes via "continue" | Reuse transcript viewer |
| **DLQ / incidents** (`/bots <id> dlq`) | Text table (the `/bg list` pattern) with reason codes + `replay` action | New, composed |
| **Storage** (`/bots storage`) | Text table of per-store usage/pruning state (the `/sessions` text-table pattern) | New, composed |
| **Onboard** (`/bots onboard`) | Stepwise `withMenu(selectWithArrowKeys)` pickers (menu pattern exists) + multi-line input for persona editing | Composed from menu/input primitives |
| **Status bar segment** | `🤖 Nbots` added to `TokenBarView` next to `⏳ Nbg`/`🤖 Nagents`; roster badge drives it | One segment |
| **Notifications** | New minimal surface: system notice row (existing `sendSystemNotice`) for failures/needs-you only; no toasts in v1 | New, minimal |

Control verbs unify on the `/agents` vocabulary (`pause | resume | stop | enable | disable`) — not `/bg cancel`.

### 3.3 The plumbing gap that decides smoothness

`CLIChannel.send/stream` accepts a `targetId` but **ignores it** — one global transcript. Per-bot chats require making `targetId` real: messages stored by `target:chatId`, TUI renders the active target's segment, `<Static>` keys stay per-target. This is the single biggest UX infrastructure task (est. the bulk of the TUI effort) and it also unlocks clean Telegram per-bot threads. The web SPA already half-supports this: SSE `broadcast` filters by `targetId` (`web.ts:111–116`); bots become threads with a `botId` dimension, rendered with the existing ThreadList + `StreamingMessage` + `ToolCallCard` stack.

Live-state updates ride the existing 2s `statusPollerTick` diff-check (same as sub-agents/bgTasks) — no push infra needed for the TUI; web gets a `bots` SSE topic.

### 3.4 Cross-surface consistency rules

One state, four renderers — TUI, web SPA, Telegram, HTTP API all read the same BotManager state and the same journal:
- Roster rows, run states, and reason codes use **one shared vocabulary** (`STATUS_ICONS` TUI ↔ badge colors web ↔ emoji Telegram).
- Per-bot chat is thread-scoped on every surface (Telegram: per-bot thread/topic where available).
- Typing indicators, chunking (4096 code points, frozen boundaries), and attribution prefixes ("Message from 🤖 researcher:") are identical on all chat surfaces.
- Config edits (web `/api/bots/:id` PATCH) apply atomically with the same validation everywhere; TUI is the setup wizard, web is the power editor (mirrors Hermes' quick/advanced creation split).

### 3.5 Fleet health: `mercury bots doctor`

Read-only, exit-code-bearing (1 = actionable), grouping per bot: last run failed (with recorded error) · last delivery failed · next scheduled run overdue past grace · DLQ depth over threshold · budget exceeded · scope/config validation errors. Companion ladder mirrors Hermes: `/bots` (list+states) → `/bots <id> journal` (runs ledger) → `/bots <id> dlq` (incidents, replayable) → `mercury bots doctor` (fleet sweep).

---

## 4. Phased implementation plan

**P0 — core runtime (the "bots exist and are safe" milestone)**
1. `bots/` module: config schema (`MercuryConfig.bots`), profile dir layout, validation, loader.
2. `BotManager` + bot turn loop (in-process coroutine, own registries, per-bot provider) — no queue yet (in-memory), journal on.
3. `/bots` command: list / onboard (interactive) / send / enable / disable / journal.
4. Permission isolation: per-bot `PermissionManager`, fail-closed auto-deny, no allow-all inheritance.
5. Memory scoping (`userKey` per bot, `none|own|shared-read`).
6. Tests: Vitest, colocated, tmp-dir injection (repo pattern); **provider wire-shape tests for the bot path across all providers** (LiteLLM/LM Studio are OpenAI-compat chat — see past drift).
7. Retention: write-time caps + journal rotation + SQLite checkpointing + `/bots storage` (§2.10) — cheap now, expensive to retrofit.

**P1 — durability + comms + surfaces**
7. `BotQueue` (SQLite, leases, DLQ) + idempotency; replace in-memory queue.
8. `BotBus` + `bot_send` tool + delivery receipts; Cloud relay bridging.
9. Scheduler integration (`botId` on manifests, cron lane, gate scripts).
10. HTTP API module; Telegram ingress (chunking/attribution rules per §3.1.10).
11. TUI per-bot chat: make `CLIChannel.targetId` real (transcript-by-target) — the biggest UX plumbing task; web `botId` thread dimension.
12. Notification surface: needs-you badge + system-notice rows (failures/escalations only, guaranteed completion delivery target — never OpenClaw's `target: "none"` default).
13. `mercury bots doctor` fleet health check (exit-code bearing) + DLQ/incidents with ack.

**P2 — scale + containment**
12. Optional `worker_thread` isolation mode for individual bots; warm-pool cap (Hermes-style, default 2–3).
13. Webhook ingress; group rooms (multi-bot deliberation with round caps).
14. Auto-skill synthesis from bot journals (ties into the roadmap's self-improvement wedge); bot skill marketplace presets.

---

## 5. Explicit non-goals (v1)

- No free-form user-chat takeover: bots are not the main agent; they don't answer in the owner's main session.
- No per-bot processes/threads by default (opt-in P2 only).
- No shared *write* memory between bots by default; sharing is structured (`bot_send`, artifacts), configured, and read-mostly.
- No human-in-the-loop prompts inside bot turns — fail closed, journal, review later.
- No cross-user bot sharing in v1 (Cloud relay is per-owner pairing, as today).

---

## 6. Decisions (resolved 2026-09-16, see ADR-012 in DECISIONS.md)

1. **Autonomous schedules in P0** — yes. Cron routines ship with the core runtime, on a dedicated cron lane.
2. **Default memory scope: `own`** — per-bot private namespace (Hermes/OpenClaw both default per-agent); configurable to `none`/`shared-read` at setup.
3. **Queue engine: SQLite lease queue** at `~/.mercury/bots/queue.db`, reusing the existing better-sqlite3 probe pattern.
4. **Bot↔bot delivery: fire-and-forget mailbox** (`bot_send` + delivery receipts), not nested invocation.
5. **SQLite-less devices (added 2026-09-16):** queue/memory storage backend chain better-sqlite3 → sql.js (WASM) → JSON-file lease store, chosen by runtime probe; correctness never depends on native SQLite (single-writer queue needs only durability); CI exercises the no-native path on every change (§2.11).