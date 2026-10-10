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

## ADR-011: Conscious/Subconscious Memory Model

- **Context**: The original second brain used a hard cap of 50 memories with staleness-based pruning that permanently deleted memories. This caused irreversible data loss — a 3-month-old project goal that was still relevant would be destroyed after 21-120 days of not being referenced. The cap was a blunt instrument on top of an already precise scalpel (merge, conflict resolution, confidence decay).
- **Decision**: Remove the hard cap entirely. Replace staleness-based deletion with a conscious/subconscious two-layer model. Memories that haven't been seen in 30 days move from conscious to subconscious (scope change, not deletion). Subconscious memories can be recalled to conscious when they match a query strongly. Nothing is permanently deleted except via explicit user action or conflict resolution.
- **Key changes**:
  - **Removed**: `SECOND_BRAIN_MAX_RECORDS` config, `enforceMaxRecords()` method, `pruneStale()` method
  - **Added**: `subconscious` as a third scope value (alongside `active` and `durable`)
  - **Added**: `moveToSubconscious()` — moves memories not seen in 30 days to subconscious scope
  - **Added**: `searchSubconscious()` — FTS5 search on subconscious memories
  - **Added**: `promoteToConscious()` — promotes a subconscious memory back to active/durable
  - **Added**: Conditional subconscious recall in `retrieveRelevant()` — searches subconscious only when conscious results are weak (<3 results with healthScore > 0.5)
  - **Added**: Separate subconscious scoring formula with keyword match weighted at 0.30 (vs 0.10 for conscious)
  - **Changed**: All conscious-only queries (`getActive`, `getByType`, `searchRelevant`, `totalActive`, `countByType`) now filter `scope IN ('active', 'durable')`
  - **Changed**: `prune()` return type changed from `{ activePruned, durablePruned, promoted }` to `{ movedToSubconscious, promoted, hardDeleted }`
  - **Changed**: Confidence is frozen when a memory enters subconscious — no further decay
  - **Changed**: `memoryHealthScore()` gives a -0.2 penalty to subconscious scope
- **Staleness threshold**: Flat 30 days regardless of evidence kind or scope (previously 21d active/inferred, 42d active/direct, 120d durable/inferred)
- **Recall mechanism**: Shared budget — subconscious recalled memories compete for the same 5 slots / 900 chars as conscious memories
- **Alternatives considered**:
  - Keep the 50 cap but remove hard-delete — still limits knowledge breadth
  - Increase cap to 200 — more headroom but still arbitrary
  - Tier-based caps (e.g., 20 durable + 30 active) — more complex, harder to tune
- **Consequence**: No memory is ever permanently lost to time. The subconscious layer archives everything, and the recall mechanism surfaces dormant memories when context demands it. The 30-day threshold is configurable and the recall scoring weights can be tuned based on real-world usage.

## ADR-012: Mercury Bots — persistent persona-scoped agents, in-process

- **Context**: Mercury needs a second agent kind alongside the main conversational agent: multiple persistent "bots" (marketing, research, publisher, …), each with its own character, model, scoped memory, and tool permissions. Bots must never block the main agent loop, never prompt the user at runtime, respect low-end hardware (Termux/RPi), and never lose work. Competitor research (Hermes Agent profiles, OpenClaw gateway lanes, Grok-on-X prompt templates + Automations) and Mercury's own architecture audit (see `BOTS-ARCHITECTURE.md`) inform the design.
- **Decision**:
  - **Bot = profile dir + runtime**: `~/.mercury/bots/<botId>/` holds `bot.yaml`, `persona.md`, `permissions.yaml`, `.env` (mirrors Hermes' profile primitive; persona as markdown like soul files).
  - **In-process execution**: bots run as async coroutines in a `BotManager` with a durable SQLite lease queue (`~/.mercury/bots/queue.db`) — never through `Agent.processQueue`, never one thread/process per bot (unaffordable on Termux; per-bot `worker_thread` isolation is an opt-in P2 escape hatch).
  - **Full state isolation per bot**: own `CapabilityRegistry` + `PermissionManager` (fixing sub-agents' shared-registry hazard), own provider/model resolution, own memory namespace via `UserMemoryStore` `userKey` (default scope `own`; `none`/`shared-read` configurable).
  - **Fail-closed autonomy**: no interactive approvals inside bot turns — permission questions auto-deny and journal; deny-list beats allow-list; no allow-all inheritance; token/step budgets are hard stops.
  - **Never-fail contract**: durable enqueue-before-ack, lease-based claiming with expiry requeue, failure-typed retries (transient → backoff; denials/injection-suspect → DLQ, never retried), throttled supervisor restarts with exit-code semantics, idempotency keys, run journal + replayable DLQ.
  - **Bot↔bot comms**: fire-and-forget mailbox (`bot_send`, delivery receipts, typed failure codes), bridged cross-instance via the existing Cloud `agent.message.relay`. Cron routines (separate lane) in P0.
  - **Surfaces**: `/bots` TUI command, Hono HTTP API module, Mercury Cloud `bot.*` commands, Telegram ingress; generic webhooks in P1.
- **Alternatives considered**:
  - Hermes-style process-per-bot / warm process pool (~60MB/bot) — clean isolation but unaffordable on Termux/Pi; kept as P2 opt-in only
  - JSON-file lease queue — zero native deps but weak concurrent-writer semantics vs SQLite leases
  - Direct nested bot invocation (simpler reasoning) — couples runtimes, deadlock-prone with cyclic links
- **Consequence**: Bots share the process (cheap: dozens on a Pi) but not state; the main agent's serial queue is untouched; all bot state survives crashes via the queue + journal. Sub-agent model/registry hardcoding (`providers.getDefault()`, shared registries) gets generalized as a side effect. Requires per-provider wire-shape tests for the bot LLM path (LiteLLM/LM Studio are OpenAI-compat chat).

## ADR-013: Atomic Chat as a first-class local provider

- **Context**: PR #90 (yanalialiuk) adds Atomic Chat (atomic.chat) as a local OpenAI-compatible provider, defaulting to `http://127.0.0.1:1337/v1`, mirroring the Ollama Local pattern. Security review found no vulnerabilities: no new dependencies, no secrets, base URL passes `validateBaseUrl`, model discovery reuses the existing OpenAI-compat catalog fetch, and the web server that accepts `baseUrl` binds to 127.0.0.1 only — same by-design trust boundary as `ollamaLocal`/`lmStudio`.
- **Decision**: Accept and maintain. Adapted on merge: `atomicChat` routed through `fetchOpenAICompatModels` (without dragging `lmStudio` off its dedicated fetcher), registered in `getPreferredModelsForProvider`, and treated as keyless in the web provider test endpoint. Merge commit authored by Mercury, feature commit retains the original author.
- **Note**: originally numbered ADR-012 in the PR-merge sequence; renumbered on the Mercury-bots merge, which independently reached ADR-012 for the Bots subsystem (kept — referenced throughout `BOTS-ARCHITECTURE.md` and the bots implementation).
- **Consequence**: Mercury now supports four keyless local providers (Ollama Local, LM Studio, LiteLLM, Atomic Chat). Maintenance owned by Mercury: keep `atomicChat` wired into any new provider surface (config, registry, web API, catalogs, docs), and revisit the SSRF posture if the web server is ever exposed beyond 127.0.0.1.

## ADR-014: Adopt PR #126 — AppleDouble-free web archive and hard `allowedTools` enforcement

- **Context**: PR #126 (SeashoreShi) fixes issue #122: macOS release builds produced `web.tar.gz` containing an AppleDouble entry (`._web`) because `web/` carries xattrs. bsdtar hides the entry from `tar -tzf` so build-time verification never saw it, but GNU tar lists it and `install.sh`'s `^web/` path guard rejected the asset — breaking `mercury update` on Linux. The PR also upgrades sub-agent `allowedTools` from advisory (prompt text only — the model still received every tool) to a hard runtime filter via a new `filterToolsByAllowlist` util.
- **Decision**: Accept and maintain. Verified empirically on macOS before merge: an xattr-bearing `web/` directory produced `._web` in the archive without `COPYFILE_DISABLE=1` and nothing with it. Full suite green (487 tests), `tsc --noEmit` clean. The allowlist change is a security positive (defense in depth — children can no longer invoke tools outside their allowlist, e.g. `list_agents`/`stop_agent`); the runtime filter subsumes the prompt-text filtering in `sub-agent.ts` line 516, which remains as harmless documentation. Merge commit authored by Mercury, feature commits retain the original author.
- **Consequence**: Release archives stay safe for GNU tar consumers; sub-agent tool scoping is now enforced at the SDK boundary rather than trusted to the model's cooperation. Maintenance owned by Mercury: any new tool surface exposed to sub-agents must respect `resolveTools()` (not `capabilities.getTools()` directly), and release builds on macOS must keep `COPYFILE_DISABLE=1` — re-verify archive contents with GNU tar or the `verify-standalone-release.cjs` path check before publishing.

## ADR-016: Argv-lane auto-approval and per-agent permission contexts

- **Context**: Ask Me mode auto-approved a list of "safe read" commands by matching regex patterns against the command string, then ran the string through `sh -c` with the daemon's `PATH`. Every fix to that classifier (find action flags #71/#77/#101, redirection #72/#82, variable expansion #76/#80, residual `find -fprint0`, `rg --pre`, `git --output`/`--ext-diff`) left the class open, because the check and the shell parsed the string differently, and an allowlisted name resolved through a mutable `PATH` (#103). Separately, channel, allow-all, skill elevation and session scopes were mutable fields on the one `PermissionManager` shared by the main agent and every sub-agent; an internal (scheduled) turn switched allow-all on for its duration and a concurrently running sub-agent inherited it (#75/#99 residual), a sub-agent's `use_skill` elevated the main agent, and the `/` scope an internal turn added was never removed.
- **Decision**:
  - **Two shell lanes.** The *argv lane* (`src/capabilities/shell/argv-lane.ts`) auto-approves only commands that a strict POSIX tokenizer turns into argv without meeting any shell syntax (it rejects `$`, backticks, `~`, redirection, pipes, lists, unquoted globs, `!`, `#`, subshells, env-assignment prefixes), whose `argv[0]` is a bare name on `ARGV_ALLOWLIST`, whose flags pass that program's policy (`SIDE_EFFECT_FLAGS` as the deny list over quote-removed argv, plus positive rules for `git` — read subcommands only, nothing before the subcommand — `git branch` listing, `ps` without `e`/`E`, `rg -z`, `tree -R`), whose path arguments stay inside the tool cwd or a readable scope, and whose binary exists in the pinned directories. It executes with `execFile(absBinary, argv, { cwd, env: minimalEnv(), shell: false })`; git gets `-c core.fsmonitor=false -c core.pager=cat --no-pager` and `--no-ext-diff --no-textconv`. `cd` runs in-process. Everything else is the *approval lane*: the user sees the exact string and, once approved, it may run through the shell (still via execFile when it is expressible as argv). Pipelines of read-only commands go to the approval lane — running each stage via execFile and piping in-process was rejected as more code and more policy surface for a convenience.
  - **Pinned binaries.** Allowlisted programs are resolved once at startup from `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin`, `/opt/homebrew/bin` (Windows: `System32`, `Program Files\Git\cmd`), never `process.env.PATH`; world-writable binaries are skipped. The git read tools use the same pinned git. Service files write a fixed `PATH` (system dirs plus the node binary's directory); on Windows, where Task Scheduler XML has no environment block, the `--daemon` process pins its own `PATH`.
  - **Immutable per-agent contexts.** `PermissionContext { channelType, channelId, senderRole, autoApprove, autoApproveOrigin, allowedTools, scopes, elevated }` is frozen. Sub-agents run under their own context through `AsyncLocalStorage` (`PermissionManager.withContext`), derived at spawn time by `deriveChildContext` (child ⊆ parent: tools intersected, scopes covered, no elevation, allow-all only from a user-chosen *session* grant). The supervisor stores the snapshot on `SubAgentConfig.permissionContext`, so a queued agent keeps it. The main agent's messages are serialised, so its context stays the root one; internal turns layer a turn grant (`beginTurnGrant`/`endTurnGrant`) over it that children neither see nor inherit. The legacy setters remain as shims that replace the calling agent's context. `AsyncLocalStorage.run` is used rather than `enterWith`, which on Node 20 leaks a store into the caller's continuation.
- **Alternatives considered**: hardening the regex classifier further (the approach that kept failing); a full shell parser (bash-compatible parsing is large and still has to agree with the real shell); capability tokens passed explicitly through every tool factory (correct but touches every tool; ALS gives the same isolation behind the existing API); a separate `PermissionManager` per sub-agent (approval memory, the ask handler and manifest persistence would fork).
- **Consequence**: The auto-approved path no longer involves a shell or `PATH`, so redirection/expansion/chaining/PATH-substitution bypasses do not apply to it; the remaining risk is an option of an allowlisted program that the flag policy misses. Some commands that used to run silently now prompt: pipelines and `&&` chains of read-only commands (including `cd dir && ls`), quoted absolute paths outside the workspace (`cat "/etc/passwd"`, which the old regex path gate missed), `ps -ef`/`ps e`, tools not installed in the pinned dirs (e.g. `rg` under `~/.cargo/bin`), and Windows `dir`/`type` (cmd builtins). Bare `ls`, `git status` and similar now auto-approve (the old `cmd *` patterns needed an argument). On the internal channel `requestApproval` approves only under allow-all. Maintenance owned by Mercury: new auto-approved programs go into `ARGV_ALLOWLIST` with a policy and a test row; never add a shell-dependent fallback to the argv path; any new agent-like runner must enter `withContext` with a derived context.

## ADR-017: Vendor the patched Ink renderer

- **Context**: Mercury's TUI depends on seven fixes to ink 5.2.1 (Yoga free-node hygiene, `<Static itemKey>`, freeze gate, live-region guard, diff-render, resize invalidate and — new here — hardware cursor positioning for IME, #41/#66). Until now they were applied to `node_modules/ink` by `postinstall` (`patch-package || apply-ink-patch.cjs || echo`). That path failed silently on `--ignore-scripts` installs, npm policies that block lifecycle scripts, hoisted installs, and Termux containers without `patch-package`; the stock renderer then capped the transcript at ~100 messages and re-exposed the Yoga WASM crash (ROADMAP P0.9, P2.4). `ink` was a tsup external, so even the standalone binaries depended on whatever ink was on disk at build time.
- **Decision**: Commit the patched build to `vendor/ink/` (runtime files only: `build/` without source maps, a trimmed `package.json`, `license`) and bundle it: tsup aliases `ink` → `vendor/ink/build/index.js` with `noExternal: ['ink']`, vitest aliases the same path, and `tsconfig` `paths` point the types there. The files are generated, never hand-edited: `scripts/vendor-ink.cjs` verifies the stock tarball's registry integrity, copies it, runs the hunks in `scripts/apply-ink-patch.cjs` (the single source of truth), stamps `inkPatch.vendored = true`, and rewrites `patches/ink+5.2.1.patch` as the stock-vs-vendored diff for review. `--check` rebuilds into a temp dir and fails on any byte difference (run in CI's pack-verify job). The postinstall step is removed; `post-build.cjs` and `verify-package.cjs` fail if `dist/index.js` imports `ink` at runtime or lacks the patch markers. `ink-patch-check` judges a vendored build by its runtime globals only and reports `source: 'vendored'` (`mercury doctor`: "vendored (patched ink 5.2.1 bundled)").
- **Alternatives considered**: keep postinstall and harden it (still depends on lifecycle scripts running); publish a fork as `@cosmicstack/ink` (adds a release pipeline for a package whose fixes we want upstream anyway); upgrade to ink 6 (React 19 migration, and the same fixes would still be needed).
- **Consequence**: Every install path — npm with or without scripts, Termux, Bun binaries — runs the identical patched renderer. `ink` stays in `dependencies` for now, used only for its transitive packages at build time; moving it to `devDependencies` (and dropping `patch-package`) needs a lockfile regeneration and is left as a follow-up. Two bundling details: ink's DEV-only React DevTools module is replaced by an empty stub (esbuild would otherwise inline `react-devtools-core`, which crashes at load), and the bundle banner defines `require` via `createRequire` because ink's CommonJS dependencies require node builtins. Upgrading ink means: bump `INK_VERSION`/`INK_INTEGRITY` in `scripts/vendor-ink.cjs`, re-anchor the hunks, regenerate, and review the patch file. Each hunk's rationale and upstream status is in `docs/ink-patch.md`.

## ADR-018: SQLite backend selection: better-sqlite3 → bun:sqlite → node:sqlite → JSON

- **Context**: Four stores depend on SQLite — Second Brain (`src/memory/second-brain-db.ts`), the bots job queue (`src/bots/queue.ts`), boards (`src/core/board-db.ts`) and the cloud pool-search cache (`src/cloud/pool-search.ts`). Each carried its own `require('better-sqlite3')` probe. The standalone binaries (`bun build --compile`) bundle better-sqlite3's JavaScript but not its native addon, so inside a binary every probe failed on every target: Second Brain was silently disabled and bots/boards fell back to JSON (ROADMAP P1.9, §F, #96). Toolchain-less npm installs (Termux, no compiler) hit the same wall. Meanwhile both runtimes ship an embedded engine — `bun:sqlite` in Bun and `node:sqlite` (`DatabaseSync`) in Node ≥ 22.5 (unflagged in 22.13 / 23.4) — with the same synchronous shape better-sqlite3 has.
- **Decision**: One shared driver, `src/utils/sqlite-driver.ts`, exposes the minimal synchronous API the call sites already use (`openSqlite` → `prepare().run/get/all`, `exec`, `pragma`, `transaction`, `close`) and selects a backend once per process, in this order: **better-sqlite3** (when it loads and opens a file — the npm default, zero behaviour change: statements are handed through untouched) → **bun:sqlite** (when `process.versions.bun`) → **node:sqlite** (Node ≥ 22.5) → **none**, in which case `openSqlite()` returns `null` and callers fall back to JSON exactly as before (Second Brain and the pool cache stay disabled; the queue and boards use their JSON stores). Engines are loaded with a `createRequire` string require so tsup/tsc never resolve `bun:sqlite`/`node:sqlite` (both are also tsup externals). The driver normalises the engine differences that would otherwise be silent data bugs: bun:sqlite binds NULL for bare named keys unless they carry the `@`/`:`/`$` prefix and returns `null` from `get()`; node:sqlite rejects `undefined`/boolean bindings, throws on named keys the SQL does not mention, returns null-prototype rows, has no `transaction()` and throws on double `close()`. `MERCURY_SQLITE_BACKEND=better-sqlite3|bun:sqlite|node:sqlite|json` forces a backend; `describeSqliteBackend()` reports the probe outcome and `mercury doctor --storage` prints backend, DB paths, sizes, row counts and a loud warning when storage is JSON-only. `isBetterSqlite3Available()` remains as a deprecated alias of `isSqliteAvailable()` so web/API callers keep working.
- **Alternatives considered**:
  - Shipping better-sqlite3's prebuilt `.node` per target next to the binary — doubles the release matrix, needs a loader path per OS, and still leaves toolchain-less npm installs broken.
  - sql.js (WASM) as the universal engine — asynchronous init, whole-file-in-memory, no WAL; already used only as the dashboard's read-only fallback and unsuitable as a durable write path for the queue.
  - Making JSON the only store — loses FTS5 search for Second Brain and the lease semantics the bots queue relies on.
- **Consequence**: Standalone binaries get Second Brain, bots and boards on bun:sqlite with no native addon; Node 22.13+ installs work without a compiler; Node 20 keeps better-sqlite3 (a single process never mixes engines, but the files are plain SQLite so switching runtimes keeps the data). Node 22.5–22.12 only expose node:sqlite behind `--experimental-sqlite`, and Node 22.x prints one `ExperimentalWarning` when it loads. The driver's contract test (`src/utils/sqlite-driver.test.ts`) runs the same assertions against every engine the test process can load — CI should run it under Node 20, Node 22+ and `bun test` (P2.6). FTS5 is required from every engine (Node's and Bun's builds ship it). New SQLite call sites must go through the driver, bind named parameters with bare keys, and never assume `get()` returns `null`.

## ADR-019: Move the vendored renderer to ink 8; require Node 22

- **Context**: ADR-017 vendored ink 5.2.1 with seven Mercury hunks (eight after synchronized output). Upstream reached 8.0.0 with most of that work done properly: incremental rendering, synchronized output, a cursor API, Yoga free-node hygiene, scrollback-preserving fullscreen handling, and dozens of `<Static>`, input, CJK-text and Windows fixes Mercury did not have. Each ink upgrade on the old base meant re-implementing those by hand. Ink 7+ requires Node 22 and ink 8 requires React 19.3.
- **Decision**: Vendor ink 8.0.0 (same pipeline as ADR-017) and keep only what upstream still lacks: `<Static itemKey>`, the freeze gate, the live-region guard (trim instead of writing an over-tall frame, which on ink 8 pushes copies of the live region into scrollback), and a small cursor-anchor hunk that resolves Mercury's `internal_cursor` cell after layout and feeds it to ink's own `setCursorPosition`. Mercury turns on `incrementalRendering`, and after the output wrapper sheds writes it calls `instance.clear()` so the next frame is a full repaint. React moves to 19.3; `engines.node` to `>=22`; the build target to `node22`; CI drops Node 20. The bundle banner exits with a clear message on Node < 22 (Bun is exempt) instead of failing at the first render.
- **Alternatives considered**: backport ink 6–8 fixes into the 5.2.1 fork one by one (rebuilds ink 8 by hand, and every fix touches internals that changed); move to OpenTUI (native renderer, but needs Node ≥ 26.4 with `--experimental-ffi` or Bun, has no Android build for Termux, and is pre-1.0); stay on ink 5 and Node 20 (Node 20 reached end of life in April 2026).
- **Consequence**: The patch shrinks from about a thousand lines to 168 (`patches/ink+8.0.0.patch`). The same four changes are kept as TypeScript commits on the `mercury` branch of the public fork [cosmicstack-labs/ink](https://github.com/cosmicstack-labs/ink), for review, rebasing and upstream proposals; Mercury still vendors from the stock tarball plus the applier, and no package is published from the fork. Node 20 users must upgrade before installing; `mercury doctor` and the docs say Node 22. Hardware-cursor and live-region tests now assert the result on an emulated terminal (`src/ui/vt-screen.ts`) instead of exact escape bytes, so they survive ink's encoding choices. The SQLite driver keeps better-sqlite3 first; Node 22.13+ also has `node:sqlite` (ADR-018).

## ADR-020: Bot turns are governed; runs are judged by their trace

- **Context**: Eleven days of two real fleets (13 bots, ~1,150 runs): 617M input tokens, a median turn of 750k tokens and a maximum of 6.6M, 38% of lead runs failed, and most output was notes about earlier runs ("records", "receipts", "mirror certs") — 372 of 637 files in the shared folder. Causes: no per-turn cap and no context compaction (25 steps × 6 continuations, every step re-sending every tool result); cron and self-schedules firing regardless of whether the bot was busy or anything had changed, with bot-created routines unbounded (one bot made a `*/5` routine whose prompt said "DO NOT EXECUTE"); 900 chars of memory, so the bot's only continuity was files it wrote and re-read; free-text comms with no fan-in; `terminated` and other network cuts classified permanent (135 dead-letters); finals hidden in `~/.mercury/bots/outputs/<botId>/` split across ten crew folders, never mentioned at onboarding; "Full access" plus relative paths resolving against the daemon's cwd, so a bot wrote into whatever repo the daemon was started from.
- **Decision**:
  - **Turn governor** (`bot-turn.ts`): hard caps per turn (300k tokens, 20 minutes; per-bot `autonomy.maxTokensPerTurn` / `maxTurnMinutes`), tripped through a local abort chained to the halt signal. A tripped cap is terminal (`turn_budget` / `turn_time`) but not an escalation: settled done, no DLQ, no needs-you, one owner notice per bot per day. Context is compacted on every step via the SDK's `prepareStep`: the newest 8 tool results stay verbatim (24KB each), older ones become a stub.
  - **Budgets by default** (`bot-manager.ts`): the per-bot daily cap falls back to `bots.suggestedDailyTokenBudget` (5M); `dailyTokenBudget: 0` is the only way to be unlimited. A fleet-wide `bots.fleetDailyTokenBudget` (20M) pauses every bot for the day. 80% warns once.
  - **Routine gate**: a cron tick is rejected (`busy`, `too_soon`, `routine_paused`) rather than queued when the bot has queued or running work, when the routine ran within `minIntervalMinutes` (default 30), or when the routine is paused. Delegated tasks and chat are never gated. `bot_schedule` refuses routines more frequent than 30 minutes, more than 3 per bot, and follow-ups under 10 minutes.
  - **Outcome verdict**: each run carries an expectation set by the manager from its trigger — `work` (cron, self, API), `message` (chat, delegated task), `check` (bare mailbox wake, or a routine declaring `expects: check`). The turn's tool trace yields `deliverable | action | delegated | message | none`; a file write counts as an action only outside the sandbox roots, a command only if its head is not read-only, a delivery always. A `work` run at `none` receives one nudge (at most 8 steps) and is then journaled as it is. The reply's own claims are checked against the trace (`claimedWithoutAction`). Three consecutive `none` runs pause the routine (`routine-state.json`); `/bots start` clears it.
  - **Shared-folder budget**: the bot's write tools are wrapped for the turn; writes into `_shared/` warn past 2 files / 32KB and are refused past 6 / 128KB. The private workspace is not limited.
  - **Deliverables** (`BotStore.deliverablesDir`): `<root>/<Bot name>/` for leads and solos, `<lead>/work/<crew>/` for crew; the root defaults to the platform Documents folder (Termux shared storage; `<MERCURY_HOME>/deliverables` when a custom home is set, so tests and the eval harness never touch a real Documents folder), overridable with `bots.deliverablesDir`. `bot_deliver` takes `title` and `final`; crew cannot produce finals; files are named `YYYY-MM-DD <title>.<ext>` and the folder keeps a README index. The path is in the bot's system prompt, the onboarding messages, the roster and every delivery notice. The legacy `outputs/` zone is migrated once at startup.
  - **Failure classes**: `terminated`, socket closes and interrupted streams are `provider_timeout`; the SDK's "No output generated" is `provider_empty`; both retry. Stream `error` parts are captured so the real provider error is classified. Retry wrappers are unwrapped before classification.
  - **Journal v2 + transcripts**: `turnStartedAt`, `steps`, `toolCalls`, `peakInputTokens`, `outcome`, `deliverables`, `claimedWithoutAction`, `routineId`; a compact JSON transcript per run under `transcripts/` (retention `transcriptRuns`, default 50).
  - **Anchoring and scanning**: the bot registry's cwd is the bot's workspace; the roster scan descends only into profile dirs and never into `sandbox/`, `outputs/`, `skills/`, `transcripts/`.
- **Alternatives considered**: judging runs by the reply text (what the bots were already gaming); a cheaper model for routines instead of a gate (still 100% duty cycle); keeping deliverables under `~/.mercury` with a symlink (hidden folders are the problem, not the path); per-bot process isolation (unchanged: cost is the issue, not isolation).
- **Consequence**: An idle fleet costs nothing; a busy one is bounded per turn, per bot and per fleet. A bot that narrates instead of delivering is visible in the journal within a run and paused within three. Owners open one folder per fleet. Existing bots change behaviour: cron ticks are now skipped when busy or too soon, every bot gets a 5M/day cap unless set to `none`, and the article-writer-style "every 10 minutes" persona is still accepted but can only fire every 30. Wave 2 (typed task/result protocol with fan-in, bot memory extraction, pipelines as data) builds on the outcome verdict and the deliverables folder.
