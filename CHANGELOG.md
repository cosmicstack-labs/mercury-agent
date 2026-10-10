# Changelog

## Unreleased — bots that do work (ADR-020)

An audit of eleven days of real fleets found bots spending 617M input tokens (a median turn of 750k, the largest 6.6M), failing 38% of runs, and mostly writing notes about earlier runs. This wave gives every bot turn a governor, every routine a gate, every run an outcome verdict, and every owner a folder they can find.

- **Per-turn caps.** A turn stops at 300k tokens or 20 minutes (`autonomy.maxTokensPerTurn` / `maxTurnMinutes`). A cut-off is journaled as `turn_budget` / `turn_time` — terminal, no dead-letter, no "needs you", one notice a day.
- **Context compaction.** Tool results older than the last 8 are stubbed on every step; any single result is capped at 24KB. Prompts stop growing with the number of steps.
- **Budgets on by default.** Every bot has a daily cap (5M tokens unless `/bots budget` says otherwise; `none` = unlimited) and the fleet has one (`bots.fleetDailyTokenBudget`, 20M). You are warned at 80%.
- **Routine gate.** A cron tick is skipped — never stacked — while the bot is busy or within 30 minutes of its last run (`schedules[].minIntervalMinutes`). Bot-created routines run at most every 30 minutes, at most 3 per bot; self-scheduled follow-ups are at least 10 minutes out.
- **Outcome verdict.** The tool trace, not the reply, decides what a run did: `deliverable`, `action`, `delegated`, `message` or `none`. An unattended run that only wrote notes gets one nudge to deliver or admit it. A reply that claims delivery with no matching tool call is flagged. Three empty runs in a row pause the routine; `/bots start` resumes it.
- **Shared-folder budget.** Writes to `_shared/` are limited per run (warn at 2 files / 32KB, refuse at 6 / 128KB). The private workspace is unlimited.
- **Deliverables you can find.** Results go to `~/Documents/Mercury/<Bot name>/` (Windows: Documents; Termux: shared storage; `bots.deliverablesDir` overrides) — finals on top, crew work under `work/`, a README index, files named `YYYY-MM-DD <title>`. Shown at onboarding, in the roster, and in every "delivered" message. `/bots outputs [id]` lists them, `/bots folder <id>` opens the folder. The hidden `outputs/` zone is migrated once.
- **Honest failures.** Network cuts ("terminated", socket closed, interrupted streams) and empty streams retry instead of dead-lettering; the provider's real error (an invalid key, a 429) reaches the journal instead of "No output generated".
- **Journal v2.** Real turn start, steps, tool calls, peak prompt size, outcome and delivered paths per run, plus a compact transcript per run (last 50 kept). `/bots journal` shows them; `mercury bots doctor` flags bots whose unattended runs mostly produce nothing, paused routines, and write access to the whole home directory.
- Bot file tools and shell commands now resolve relative paths inside the bot's workspace, never the daemon's working directory. The roster scan ignores profile copies in `sandbox/` and `outputs/`.

## Unreleased — ink 8

Mercury's terminal renderer moves from a heavily patched ink 5.2.1 to ink 8.0.0, which now does most of that work itself.

- **Requires Node.js 22 or newer.** Ink 7+ needs it, and Node 20 reached end of life in April 2026. On an older Node, Mercury now exits with a clear upgrade message instead of crashing at the first render.
- **Smoother rendering** — incremental rendering rewrites only the changed part of each line, and every frame is painted atomically (synchronized output).
- **Upstream fixes Mercury lacked** — CJK and emoji truncation, control characters stripped from rendered text, dropped keypresses when several keys arrive together, Backspace vs Delete, Windows stale frames, and many `<Static>` fixes.
- **Smaller patch** — four Mercury hunks remain (Static `itemKey`, freeze gate, live-region guard, cursor anchor); the rest are upstream. See `docs/ink-patch.md` and ADR-019.
- React 19.3.

## 1.3.1 — Honest Mercury

The release where Mercury stops pretending. Chat answers instead of forcing tool rounds, "done" means a check actually passed, every channel shows the same evidence, and the terminal UI takes paste, Esc and IME like a real editor. Built from a full audit (`ROADMAP.md`); every change below is covered by tests, including a replay eval harness that drives the real agent loop.

### Conversation and feedback

- **Chat is no longer forced through tool rounds** — the Mercury Code narration guard and verification gate ran in plain chat, so "make me a workout plan" could trigger up to ten tool-only rounds and end with "I couldn't get started". Both now run in execute mode only.
- **Done means verified** — a build/test/typecheck counts as evidence only when it exits clean (timeouts and kills are failures) and runs after the last edit; otherwise the task pauses with "the last check didn't pass" instead of "Task complete". Streamed turns now reach this gate too (they reported no finish reason and skipped it).
- **One feedback contract on every channel** (`TaskSurface`) — begin, done-with-evidence, pause and fail behave the same on CLI, web, Telegram, Discord, Slack and Signal. Verification notes and a trace id reach messaging channels; pause and failure banners are persistent messages, never truncated status-card notices.
- **`/trace [id]`** — provider, tokens (incl. cached), steps, timing, verification and every tool call for a turn.
- **`/new`** on every channel — fresh conversation, memory kept (#38).
- **Telegram prompts** — timeouts say what they defaulted to, taps settle the card, keyboards are removed (#23).

### Context, memory and speed

- **Context window v2** — history is budgeted by tokens and includes a compact per-turn tool trace, so the next turn knows what was read and written. Retrieved memory goes into a per-turn system block instead of fake dialogue.
- **Prompt caching** — the stable system prompt carries an Anthropic cache marker and no longer changes every minute.
- **Faster steps** — per-step channel edits no longer block the agent loop; niche tool schemas (Spotify) are left out of unrelated turns; the cloud memory pool is skipped when local recall is strong.
- **Providers** — DeepSeek thinking for V4/reasoner models with reasoning passed back (#24); per-provider output ceilings; the configured default always leads (fallback is no longer sticky).
- **Long builds** — `run_command` reports progress so a 10-minute build is not killed as a stalled provider, and stops its child when the turn is interrupted.
- **Tool results** — read from the AI SDK v6 `output` field, so failing-loop detection works.

### Terminal UI

- **Paste** — multi-line and bracketed paste; Shift+Enter inserts a newline.
- **Esc interrupts a turn; Ctrl+C clears input**, double-tap to quit.
- **Concurrent prompts queue** instead of overwriting each other.
- **Smoother streaming** — fence-aligned tail rendering, one shared tick, async git header, correct repaint on resize; grapheme-aware cursor for emoji and CJK; history persists to `~/.mercury/history`.

### Platforms

- **Windows** — service install via Task Scheduler XML with an HKCU Run fallback (#13); graceful stop and upgrade; wizard no longer exits silently on closed stdin (#64); update check over HTTPS.
- **Termux** — detected on `android`; `mercury service install` writes a Termux:Boot script.
- **Bots** — retried jobs can no longer run twice; a fleet lead's synthesis reaches its thread; "needs you" survives restarts.

### Engineering

- **Agent split** — command handlers moved to `src/core/commands/`; one step handler instead of four copies; `agent.ts` from 8,362 to about 5,000 lines.
- **Replay eval harness** (`npm run eval`) in CI.
- **CI** — binary smoke tests per OS (built, run and discarded, never published), installer and script checks, Node 24, linux-arm64, ESLint ratchet (provisional baseline), vendored-Ink integrity check.


### Security

- **Argv-lane auto-approval** (ADR-016) — auto-approved commands no longer go through a shell or `PATH`: they must tokenize to plain argv, use an allowlisted program with an allowed flag set, stay inside the workspace, and run via `execFile` on a binary resolved from pinned system directories with a minimal environment (#103). Everything else is shown to the user for approval. Some read-only one-liners (pipelines, `&&` chains) now prompt; see `SECURITY.md`.
- **Reads are authorised against the real file** — symlink targets must be in scope, hard-linked files prompt, and `read_file` verifies the opened file is the one that was checked (#104).
- **Git helpers run argv, not a shell string** — `git_status`, `git_log` and `git_diff` built a command string from a model-chosen `path` and ran it through `execSync` with no permission check. They now pass the path to `execFileSync('git', [...])` as a single argv element after `--` (or `-C <resolved>`), and refuse any path that fails the same read-scope check `read_file` uses. `git_push` rejects option-looking `remote`/`branch` values (`--receive-pack=…`, `--exec=…`) and also uses argv. Regression tests: `src/capabilities/git/git-helpers.test.ts`.
- **Safe-read bypass fixes, now closed with regression tests** — the read-only auto-approval lane in Ask Me mode denies: `find` action flags (`-exec`/`-execdir`/`-ok`/`-okdir`/`-delete`, since 1.2.2; `-fprint`/`-fprintf`/`-files0-from` since 1.3.0 — #71, #77, #101, #110); shell redirection (`>`, `>>`, `2>`, `<`, `&>`, since 1.2.2 — #72, #82, #109); and shell expansion (`$VAR`, `${VAR}`, `$(…)`, backticks, `$'…'`, `~`, since 1.3.0 / PR #128 — #76, #80, #95). An explicit `find -exec` case was added to `src/capabilities/permissions.test.ts`.
- **Sub-agent approval routing** — `delegate_task` workers no longer switch the shared permission manager into allow-all with a `/` write scope; their shell and filesystem calls go through the same Ask Me prompts as the parent (since 1.2.2 — #75, #99). `allowedTools` is enforced at runtime, not just in the prompt (since 1.3.0 — #74, #97, #98). In 1.3.1 sub-agents only see and stop their own descendants and get orchestration tools only when granted (#74), and each agent runs under its own immutable permission context, so a concurrent internal-channel turn can no longer widen a worker's approvals (#75/#99 residual).
- **Symlink write canonicalisation** — `create_file`/`write_file`/`edit_file` check the resolved target of a symlink against the writable scopes, not only the lexical path (since 1.3.0 — #105).
- **SSRF guard** — unchanged; see the 1.2.3 entry below (hardened in 1.3.0 by #121 and #124; response record in `docs/security/ssrf-108-response.md`).
- **Disclosure process** — `SECURITY.md` added (private reporting, response targets, scope); issue-closure and advisory drafts in `docs/security/2026-10-backlog-closure.md`.

### Fixed

- **SQLite in the standalone binaries and on toolchain-less installs** (ROADMAP P1.9, #96, ADR-018) — the binaries bundled better-sqlite3's JavaScript but never its native addon, so every SQLite probe failed inside them: Second Brain was silently disabled and bots/boards fell back to JSON. A shared driver (`src/utils/sqlite-driver.ts`) now selects **better-sqlite3 → bun:sqlite → node:sqlite → JSON**: binaries use Bun's embedded engine, Node ≥ 22.13 installs work without a compiler via `node:sqlite`, and the better-sqlite3 path is untouched. Second Brain, the bots queue, boards and the cloud pool-search cache all go through it; the pool cache now degrades to uncached instead of throwing when no engine loads. New `mercury doctor --storage` prints the active backend (with why the others were rejected), every database file, its size and row counts, and warns loudly when storage is JSON-only. `MERCURY_SQLITE_BACKEND=better-sqlite3|bun:sqlite|node:sqlite|json` forces a backend. Contract tests run the same assertions against every engine the process can load (`src/utils/sqlite-driver.test.ts`).
- **Patched ink is bundled, not post-installed** (ROADMAP P2.4, ADR-017) — the TUI's ink fixes no longer depend on `postinstall`: `vendor/ink` (stock ink 5.2.1 + the patch set, regenerated by `scripts/vendor-ink.cjs`) is bundled into `dist`, so `--ignore-scripts` installs, Termux and the standalone binaries all run the patched renderer. `mercury doctor` reports "Ink TUI patch: vendored". Hunk-by-hunk rationale: `docs/ink-patch.md`.
- **IME input lands on the input line** (#41, #66) — the real terminal cursor is now parked on the input's cursor cell after every frame, so preedit text and candidate windows appear where you type, and terminals that suppress IME while the cursor is hidden compose again. It is hidden while a prompt or a non-input pane has focus. `MERCURY_HW_CURSOR=0` opts out.
- **Narrow terminals** (P2.8) — widths derive from the terminal's columns: below 60 columns the splash and side panels collapse, and the input header, hints and Mercury Code hint table truncate instead of wrapping into extra live-region rows.

## 1.3.0 — Mercury Bots

Persistent, persona-scoped agents that run **outside your conversation** — each with its own persona, workspace, skills, permissions, and durable queue. Onboard specialists, chain them into multi-level fleets, and let them work 24/7 while you keep talking to Mercury.

### New

- **Persistent bot runtime (P0)** — Bots are long-lived agents with a persistent persona (`bot.yaml` + `permissions.yaml`), their own private sandbox at `~/.mercury/bots/<id>/`, and journals that survive restarts. A wake turns them on; they work through a durable job queue; results land **in the bot's own thread** — never dumped back into the session that dispatched work.
- **Durable queue + HTTP API (P1)** — Jobs survive restarts and lease-expire when a worker dies (`timed out` classification, non-destructive DLQ replay via `/bots replay`). Fleet health is one command away: `mercury bots doctor` (exit 1 = actionable), `mercury bots list`, `mercury bots storage`. Telegram `/pair`-style ingress: every bot reachable through the channel you already use.
- **Fleets — lead bots + crews** — Promote a bot to **fleet lead**; it recruits and organizes its own crew (imperative self-organization). Multi-level hierarchies supported. Crew results bubble up through the lead. Fleet onboarding walks tiers: **solo → lead auto-build → lead manual**.
- **Web cockpit — Mercury Bots section** — The local web dashboard gained a fleet section: roster with live states, per-bot threads, needs-you escalation badges, and a fleet step view that mirrors the TUI.
- **Persona system** — Two-pass persona builder keeps big personas big; hand-edited `bot.yaml`/`permissions.yaml` apply live. Persona file declares access scopes (read/write/execute per directory), so each bot gets exactly the surface it needs — no more.
- **Sandbox + `bot_deliver`** — Every bot gets an isolated workspace; final artifacts go out through `bot_deliver`. Sandbox retention janitor caps per-bot disk usage; fleet-shared folder at `~/.mercury/bots/_shared` for cross-bot files with implicit grants.
- **Bundles** — `/bots export` produces a shareable bundle (manifests + personas + permissions + skills; a lead's bundle carries its whole crew, whole-fleet export supported). `/bots import` recreates them — imported bots start disabled by design. Sandbox, journals, and `.env` never travel.
- **Bot-facing tools** — `dispatch_bot`, `bot_schedule` (bots schedule their own future runs), `bot_deliver` (finalize artifacts), `fleet_status`, `journal_append`. Skill access for bots: native skill library + per-bot skill libraries with auto-synthesis.
- **Lifecycle + observability** — Full create/edit/budget/delete lifecycle, stop/start/run with held-queue semantics (stop holds, never kills), needs-you alerts to your active channel, journal hydration restores per-bot threads on open, live activity bus feeds the roster and cockpit, per-bot token budgets, mtime-cached manifests, tail-read journals, `mercury bots storage` for disk usage.
- **Permission tiers at onboarding** — Bots get `ask` / `allow` tiers per capability, set explicitly — nothing defaults silently. Per-bot shell allow-lists flow from `permissions.yaml autoApproveCommands`; malformed scope entries skip + warn, never crash turns.

### Fixed

- Fleet duplication on reopen; `/bots` stays inside the bot thread it opened.
- Bot thinking streams into its thread live; fleet speed fixes (single-provider lease wait, batched roster fetches).
- Web fleet step mirrors the TUI step view exactly (solo / auto-build / manual tiers).
- Results no longer sliced at 800 chars in bot threads; delivery-contract gaps closed with durable retries + durable mailboxes.
- Windows hardening: queue teardown EBUSY on SQLite backend, EBUSY on heartbeat test backends, EINVAL on retention backdating, separator-agnostic traversal guard; post-close queue ops degrade to no-ops, not crashes.
- JSON backend lease-expiry race closed; SQLite queue handle released on teardown; doctor closes its queue.
- Telegram member installs blocked `install_skill` — tool surfaced only where it's safe.
- `mercury bots doctor` scheduler linkage: routines registered in schedules but missing from `bot.yaml` are flagged before they silently never fire.

### Internal

- New `src/bots/` module: `store.ts`, `queue.ts` (SQLite + JSON backends), `bot-manager.ts`, `bot-turn.ts`, `journal.ts`, `bundle.ts`, `doctor.ts`, `persona-template.ts`, `fleet-*`, `skill-synthesis.ts`, `retention.ts`, `tools/` (`dispatch-bot`, `bot_schedule`, `bot_deliver`, `fleet_status`, `journal_append`).
- `mercury bots` — new CLI command group (`doctor` / `list` / `storage`) mirroring the in-chat `/bots` surface.
- PRs #131–#139 + PR #117's RevShare integration carry this release.

### Migration from 1.2.7

No breaking changes. Bots are **opt-in** — onboard your first bot with `/bots create <id> "Name" "Description"`; the doctor and fleet surface appear as soon as you have a fleet. Existing config, memory, and channels are untouched.

## 1.2.7 — Polished Mercury

UX-polish on the Mercury Code surface: every command in autocomplete, honest completion stats, and status verbs that describe what's happening without an extra model call.

### New

- **50/50 RevShare Integration: Mercury & AIML API** (#117) — revenue-share program integration.
- **Dynamic status verbs** (#119) — one LLM call per session generates live status verbs ("Compiling", "Sweeping"), chat stays static.
- **"Did you know?" tips** (#120) — surface-categorized, rare, system-voice tips about features you haven't used.

### Fixed

- Step narrations render as separate blocks in the live tail; the `│` rule stays on settled messages, only the live tail drops it.
- Slash autocomplete + `/help` cover every recent command, on every surface.
- File-change stats in the completion banner are smart-conditional (no noise for prose-only turns).
- CLI uninstall discovery works on machines with no real install.

## 1.2.6 — Command Surface Fixes

Hotfix on 1.2.5: slash autocomplete and `/help` now list every recent command on every surface; the live tail renders step narrations as separate blocks with the `│` rule behavior corrected.

## 1.2.5 — Restore & Republish

Recovery release: restores the Release/1.23 work dropped by a bad merge (40f5aea), rebuilds Pages output without merge-conflict markers, and re-publishes the 1.2.4 line cleanly.

## 1.2.4 — Landing & Cards

Website/branding release: richer per-page OG social-card generator with sections and breadcrumbs, inline SVG icons replace emojis on the landing page, and the v1.2.3 release page fix ships in the built docs bundle.

## 1.2.3 — Unstoppable Mercury

The release where **Mercury Code stops dying and starts telling the truth.** The completion pipeline was rebuilt around a completion contract: every task ends in a verdict — verified completion, or an honest pause that names its blocker and resumes. Tasks can no longer fake success, die silently, or loop forever.

### New

- **Completion contract** — Every task end is classified (`completion-verdict.ts`): budget exhaustion is a *pause*, never a fake "Task complete". Evidence-gated completion: implementation tasks must run a build/test/typecheck before claiming done. Honest banners: "Response delivered · no file changes" when git shows nothing, "Task paused · send continue" when resumable.
- **AUTO mode** — Mercury Code's new default: plan and build in one flow, one `ask_user` confirmation only for large changes. No more manual plan/execute switching.
- **Live plan checklist** — the `update_plan` tool maintains a visible checklist in Mercury Code (pending / ▶ active / ☑ done), so you always see which step is being implemented.
- **Escalation harness for narration-locked models** — the agent mechanically forces action: harness grounding (deterministic directory listing), provider-enforced `toolChoice: 'required'` on mutating-tools-only steps, provider rotation per guard round, and a wake-up call (doubled bound, blunt directive) before any pause.
- **Compact-on-pressure** — OpenCode practice adopted: memory pressure now compacts the conversation in place and continues; abort only if pressure persists.
- **No Mercury-imposed output size limit** — the model's native limit governs (32,768 ceiling); providers that reject it get an adaptive halving. Big single-file writes land in one call.
- **Write-truncation recovery** — severed file writes get sectioned-write guidance (create first ~80 lines, then `edit_file` appends) with full-budget resume rounds.
- **Stall watchdog** — 3 min silence → visible pulse; 8 min → abort into resume machinery. `MERCURY_STALL_SOFT_MS` / `MERCURY_STALL_HARD_MS`.
- **Automatic continuation** — step budgets and provider failures continue automatically (6 fresh budgets, provider hard-deadline counts as one attempt); the manual "continue" gate is a backstop, not a checkpoint.
- **Interactive choice picker in Mercury Code** — `ask_user` prompts now render in the full-screen TUI (previously invisible → hang) and own the keyboard; Esc cancels safely.
- **Live thinking preview** — model reasoning streams as a quoted preview in the TUI instead of 52 seconds of dead air.
- **Trackpad/wheel scrolling in Mercury Code** — full-screen transcripts scroll with the wheel via a filtered stdin proxy (mouse sequences never leak into input).
- **Change summary at completion** — per-file +/− stats and verification evidence ("✓ Verified: npm test ✓") in the completion banner.
- **File-change previews** — bounded, syntax-highlighted excerpts of every created/edited file in the transcript.
- **`/code chat`** — instant exit from Mercury Code to regular chat; `/chat` teardown fixed.

### Security

- **SSRF guard** — `fetch_url` and `install_skill` validate scheme + private ranges (DNS-resolved) on every redirect hop; 512 KB caps. `MERCURY_ALLOW_PRIVATE_FETCH=1` opt-out.
- **Credential file hardening** — `web-config.json` / `web-sessions.json` written 0600 and repaired on load.
- **Random initial web password** — no more hardcoded default from a public repo.
- **Secret redaction** — API keys masked in logs (pino error serializer) and command output echoes.
- **Shell blocklist** — swapped-flag `rm -fr` variants added to the never-execute tier.

### Fixed

- Yoga WASM "memory access out of bounds" crashes (ink patched: freed-node hygiene + `<Static>` identity dedup) and the duplicate-message render loop.
- Scroll repair after long-session trims (`/mc scroll-set` was dead code — parsed as a NaN delta).
- Prose questions no longer fight the guard; AUTO-mode banner gating; `not-a-git-repo` false "no file changes" claim.
- Mercury Cloud recovery error now says "run `mercury cloud connect`" instead of an opaque 401 loop.
- Chat-mode thinking indicator surfaces live provider/phase activity.


## 1.1.13 — Chatty Mercury

Mercury gets chatty. Three new channels — Discord, Slack, and Signal — bring Mercury to where you already are, with end-to-end encryption, organization access models, and real-time streaming. Plus long-running loop fixes, CLI heartbeat improvements, and crash recovery.

### New

- **Discord channel** — Full bot integration with slash commands, streaming responses, rich embeds, organization access with admin roles and pairing codes, DM + channel support, and rate limiting. Config: `DISCORD_ENABLED`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_ADMIN_ROLE_NAME`, `DISCORD_STREAMING`.
- **Slack channel** — Socket Mode bot (no public endpoint needed) with slash commands, streaming edits, organization access with admin/member roles, channel + DM support, and @mention awareness. Config: `SLACK_ENABLED`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_TEAM_ID`, `SLACK_STREAMING`.
- **Signal channel** — End-to-end encrypted via `signal-cli` bridge. Group mode (named "Mercury" group) and private DM mode. Auto-managed `signal-cli` binary (download, register, start, health-check). Pairing-code access control. Phone number redaction in CLI output. Linux (x64/ARM64) native binaries available; macOS requires Java 17+; Windows not supported. Config: `SIGNAL_ENABLED`, `SIGNAL_PHONE_NUMBER`, `SIGNAL_MODE`, `SIGNAL_GROUP_ID`, `SIGNAL_GROUP_NAME`.
- **Crash recovery** — New crash flag system (`~/.mercury/.crash-flag`) writes a JSON file on ungraceful exit. On next startup, Mercury reads the flag, reports what happened, and deletes it. The watchdog also writes a crash flag on max-restart exceeded, with a synchronous stderr write as last-gasp logging.

### Fixed

- **CLI heartbeat updates in place** — The CLI now updates the same message instead of stacking new "⏳ Working..." messages during long-running tasks. Other channels (Telegram, Discord, Slack, Signal) continue sending separate heartbeat messages.
- **All 12 silent task failure paths eliminated** — Every loop condition, tool limit, and stall now sends an explicit error message to the channel. No more silent disappearances mid-task.
- **Step log collapse** — Active step logs show at most 3 visible steps (running + last 2 completed). Full history available via Ctrl+D or `/log`. Idle shows compact summary line.
- **ThinkingIndicator shows "Processing"** — Replaces agent name with a neutral label; long operations show `/bg current` hint.
- **Ollama Local routed through OpenAI compat** — `ollamaLocal` now uses `OpenAICompatProvider` with `useChatApi: true`, bypassing the `ollama-ai-provider` v1 specification incompatibility with AI SDK v6.
- **Daemon graceful shutdown** — `stopDaemon` is now async: sends SIGTERM, waits up to 5 seconds, escalates to SIGKILL. Stale `signal-cli` processes are cleaned up on stop.
- **Channel send errors logged** — All `.catch(() => {})` on channel sends replaced with `.catch((e) => logger.warn({ e }, 'channel send failed'))`.

### Internal

- New `src/signal/` module: `binary.ts` (download/verify signal-cli), `jsonrpc.ts` (JSON-RPC client), `process.ts` (lifecycle), `setup.ts` (registration flow).
- New `src/core/crash-flag.ts` — crash flag read/write/clear.
- `src/types/channel.ts` — new types for Signal, Discord, Slack access models.
- `src/utils/config.ts` — config sections, access functions, and legacy migrations for all three new channels.
- `src/channels/registry.ts` — notification priority: Signal → Telegram → Discord → Slack → CLI.
- `package.json` — new dependencies: `discord.js` v14, `@slack/bolt` v4.

### Migration from 1.1.12

No breaking changes. All new channels are **off by default** — enable via `mercury doctor` or environment variables. Existing configs, providers, threads, kanban boards, and Second Brain data carry over unchanged.

## 1.1.12 — Daemon fix for standalone binaries

Hotfix on top of 1.1.11. The standalone single-file binaries shipped in 1.1.11 could not start in the background — which also meant Telegram never came online when Mercury was installed via the one-line installer (the recommended path for servers).

### Fixed

- **Daemon now starts correctly from standalone binaries** — `src/cli/daemon.ts` used to spawn the daemon as `[process.execPath, process.argv[1], 'start', '--daemon']`. For npm installs that became `node dist/index.js start --daemon` and worked. For `bun --compile` standalone binaries, `process.execPath` is the Mercury binary itself and `process.argv[1]` is a bun-virtual `$bunfs/...` path, so the spawn became `mercury "$bunfs/..." start --daemon` — Commander treated the bunfs path as an unknown subcommand, the child died immediately, and `channels.startAll()` (the only place Telegram is started in daemon mode) was never reached.
- **`mercury service install` no longer persists broken commands** — the LaunchAgent plist, systemd unit, and Windows Task Scheduler entry now contain the binary-only invocation (no script path) when running from a standalone binary, so auto-start on boot works end-to-end.
- **Telegram now comes online in background mode for standalone-binary users** — direct consequence of the daemon fix.

### Internal

- New `isStandaloneBinary()` / `buildDaemonSpawnArgs()` helpers in `src/cli/daemon.ts` plus `getServiceLaunchArgs()` in `src/cli/service.ts`, wired through every OS installer. Detection uses `process.versions.bun`, `$bunfs` / `~BUN` markers in `argv[1]`, and the `execPath` basename — so `node`, `bun <script>`, and standalone `mercury` invocations all do the right thing.

### Migration from 1.1.11

No changes required. After upgrading, run `mercury restart` (or `mercury service uninstall && mercury service install` if you had the service installed under 1.1.11 with the broken command persisted).

## 1.1.11 — Token Saver Mode, Skills System & Standalone Binaries

The biggest release since the 1.1.x line started. Adds a full **Skill System**, a **Token Saver Mode** for cheaper sessions, **standalone binaries** for users who don't want npm, and a redesigned bottom status bar with per-step spinners.

### New

- **Token Saver Mode + bottom status bar overhaul + per-step spinners** (#69) — opt-in mode that aggressively trims context, plus a new persistent status bar at the bottom of the TUI showing provider/model/token usage live, with per-step spinners replacing the single global one.
- **Skill System** (#67) — Mercury can now load and route to user-defined skills. Skills are markdown-defined behaviors that get injected on demand based on keyword/semantic match.
- **Screenshot skill** — full website capture with viewport sizing and dark/light mode toggle.
- **Standalone binaries + one-line installers** (#61) — `mercury` now ships as a single executable for macOS (arm64/x64), Linux (x64/arm64), and Windows (x64). No Node install required. Per-OS docs and a hero install widget on the website.
- **Domain migration** — `mercury.cosmicstack.org` → `mercuryagent.sh`.
- **Chinese translations** for README, ARCHITECTURE, and CHANGELOG (#53).

### Fixed

- **Skill ambiguity prompt** (#68) — no more 10-skill fan-out on weak matches; users get a numbered picker when the router is uncertain.
- **Spurious ambiguity prompts on weak keyword overlap** — the matcher used to trigger the picker on incidental word overlap; now requires real signal.
- **Release asset names aligned with published binaries** (#63) — fixes installer scripts that were pointing at the wrong filenames.
- **Per-segment shell pattern checks** (#48) — the shell permission guard now validates each shell segment independently instead of trusting a single combined check.

### Maintenance

- **Removed `anonymous-file-uploader` skill** — no longer needed.
- **`pino` upgraded** 9.14.0 → ^10.3.1 (#51).
- Spinner polish and docs updates throughout.

### Migration from 1.1.9

No breaking changes. Skill system is opt-in (drop markdown files in `~/.mercury/skills/`). Token Saver Mode is off by default — enable it from the session menu or via config. Standalone binaries are an alternative install path; `npm i -g @cosmicstack/mercury-agent` keeps working exactly as before.

> Note: `1.1.10` was skipped to keep numbering aligned across publish channels.

## 1.1.5 — Smoother Onboarding

### Fixed: Onboarding no longer blocks users without Ollama

The onboarding flow had a critical UX problem: if a user didn't have Ollama running locally or an API key handy, they'd get stuck in infinite loops with no way to skip. This release makes onboarding smooth and forgiving.

**Key changes:**

1. **Ollama Local is now skippable** — If Ollama isn't running, you can skip it entirely or manually enter a model name. No more infinite retry loops.

2. **All provider setups allow skipping** — Every API key prompt now offers manual model name entry when the provider API is unreachable, and a clear skip option. The error messages changed from red (failure) to yellow (warning) to reduce frustration.

3. **"No provider" trap removed** — Previously, if you couldn't configure any provider, you were stuck in an infinite loop. Now you can type "skip" to save your config and return later with `mercury doctor`. A hint about DeepSeek's free API is shown.

4. **Ollama Local default model cleared** — The default was `gpt-oss:20b` (a non-standard model). Now defaults to empty, and the preferred model list uses common names like `llama3.2`, `mistral`, `phi3`, etc.

5. **Clearer first-run instructions** — The LLM Providers step now says "You can skip any provider by pressing Enter" and notes DeepSeek offers free keys.

### Summary of Changes

| File | Change |
|------|--------|
| `src/index.ts` | `promptOllamaLocalModelSelection` — allow skipping base URL, manual model entry on fetch failure |
| `src/index.ts` | `promptApiKeyWithModelSelection` — manual model entry on API fetch failure, skip option |
| `src/index.ts` | `configure()` — "skip" option when no providers configured, hint about free keys |
| `src/utils/config.ts` | Ollama Local default model changed from `gpt-oss:20b` to empty string |
| `src/utils/provider-models.ts` | Ollama Local preferred models updated to common names |

## 1.1.4 — OpenAI Compilations & Provider Visibility

### New: OpenAI Compilations Provider

A new dedicated provider for **self-hosted, third-party, or any OpenAI-compatible API** — whether it's on your system, self-hosted, or a cloud service. The community asked for a way to connect to any OpenAI-compatible endpoint without it being tied to a specific vendor.

**Setup wizard flow:**
1. Enter server base URL (required) — e.g., `http://localhost:8000/v1` or `https://my-llm.example.com/v1`
2. Optionally enter API key (press Enter to skip — local/self-hosted servers often don't need one)
3. Mercury tries to fetch models from `/models` endpoint
4. If successful — shows interactive model picker with option to enter a custom name
5. If fetch fails — prompts you to manually enter the model name
6. You can always type a custom model name before saving

**Key design points:**
- API key is **optional** — local and self-hosted servers often run without authentication
- Uses Chat Completions API (`/chat/completions`), not the Responses API (`/responses`)
- `isProviderConfigured` requires `baseUrl + model` but not `apiKey`
- No model name filtering — accepts all model IDs returned by the server
- Can be set as the default provider
- Environment variables: `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_ENABLED`

### New: Provider & Model Visibility at Session Start

The active provider and model are now prominently displayed when a session starts — a **magenta badge** (`⚡ Provider · Model`) makes it immediately obvious which LLM is being used. The full provider list is shown below with `← default` markers.

Before:
```
  Providers: DeepSeek, OpenAI
  Models: DeepSeek: deepseek-chat | OpenAI: gpt-4o-mini
```

After:
```
 ⚡ DeepSeek · deepseek-chat
  Providers: DeepSeek: deepseek-chat ← default  ·  OpenAI: gpt-4o-mini
```

### Fixes: `fetchOpenAICompatModels` optional API key handling

The internal `fetchOpenAICompatModels` function now only sends the `Authorization: Bearer` header when an API key is actually configured — previously it always sent the header (even with an empty key), which caused authentication errors on local servers that don't expect auth headers.

`OpenAICompatProvider` also now handles empty API keys gracefully by passing `'no-key'` as a fallback to `createOpenAI()`, preventing crashes on unauthenticated servers.

### Summary of Changes

| File | Change |
|------|--------|
| `src/utils/config.ts` | Added `openaiCompat` to `ProviderName`, config interface, defaults, `isProviderConfigured()` |
| `src/providers/registry.ts` | Route `openaiCompat` → `OpenAICompatProvider` with `useChatApi: true` |
| `src/providers/openai-compat.ts` | Handle empty API key with `'no-key'` fallback for `createOpenAI()` |
| `src/utils/provider-models.ts` | `OPENAI_COMPAT_PREFERRED_MODELS`, optional auth headers in model fetch, no model filtering for `openaiCompat`, routing |
| `src/index.ts` | "OpenAI Compilations" in `PROVIDER_OPTIONS`, `promptOpenAICompatSetup()` with fetch→fallback flow, magenta default-provider badge at session start |
| `.env.example` | Added `OPENAI_COMPAT_*` env vars |
| `src/utils/provider-models.test.ts` | Added 2 tests for `openaiCompat` model catalog |

## 1.1.3 — Fix Ollama Cloud Provider

### What Happened

Ollama Cloud was completely broken — every request returned `404 Not Found`. Two independent bugs prevented `ollamaCloud` from functioning:

### Bug 1: Wrong SDK — Local Ollama API instead of OpenAI-compatible Chat Completions

`ollamaCloud` was routed through `OllamaProvider`, which uses the `ollama-ai-provider` package. This package is designed for **local** Ollama servers and targets `/api/chat` and `/api/tags` endpoints. Ollama Cloud exposes an **OpenAI-compatible** API at `/v1/chat/completions` and `/v1/models` — a completely different wire format.

- **Model listing** called `${baseUrl}/tags` → `https://ollama.com/api/tags` → 404
- **Chat completions** called `${baseUrl}/chat` → `https://ollama.com/api/chat` → 404

**Fix**: `ollamaCloud` is now routed through `OpenAICompatProvider` (using `createOpenAI()` from `@ai-sdk/openai`), matching the pattern used by all other OpenAI-compatible cloud providers (MiMo, Grok).

### Bug 2: Wrong default base URL

The default `OLLAMA_CLOUD_BASE_URL` was set to `https://ollama.com/api` — the local Ollama server path. The correct base URL for Ollama Cloud's OpenAI-compatible API is `https://ollama.com/v1`.

**Fix**: Updated the default and added a config migration (`migrateLegacyOllamaCloudBaseUrl`) that automatically upgrades existing `mercury.yaml` files from `/api` to `/v1` on startup.

### Bug 3: Responses API instead of Chat Completions API

After fixing Bug 1, `OpenAICompatProvider` used `createOpenAI()()` which defaults to OpenAI's **Responses API** (`/responses`). Ollama Cloud only supports the **Chat Completions** API (`/chat/completions`), resulting in `https://ollama.com/api/responses` → 404.

**Fix**: Added `useChatApi` option to `OpenAICompatProvider`. When enabled (as it is for `ollamaCloud`), it calls `client.chat(model)` instead of `client(model)`, targeting `/chat/completions`.

### Bug 4: No baseUrl validation for ollamaCloud

`isProviderConfigured()` and `OllamaProvider.isAvailable()` only checked `apiKey.length > 0` for `ollamaCloud` — a missing or empty `baseUrl` would not be caught, causing a cryptic failure at request time.

**Fix**: Added explicit `ollamaCloud` branch in `isProviderConfigured()` and `isAvailable()` to validate both `apiKey` and `baseUrl`.

### Summary of Changes

| File | Change |
|------|--------|
| `src/providers/registry.ts` | Route `ollamaCloud` → `OpenAICompatProvider` with `useChatApi: true` |
| `src/providers/openai-compat.ts` | Add `useChatApi` option to use Chat Completions API |
| `src/utils/config.ts` | Default base URL `https://ollama.com/api` → `https://ollama.com/v1`; add `ollamaCloud` to `isProviderConfigured()`; add `migrateLegacyOllamaCloudBaseUrl()` |
| `src/utils/provider-models.ts` | New `fetchOllamaCloudModels()` using `/models` (OpenAI-compatible); rename `fetchOllamaModels` → `fetchOllamaLocalModels` (local `/tags` only); route `ollamaCloud` separately |
| `src/providers/ollama.ts` | `isAvailable()` also validates `baseUrl` for non-local providers |
| `.env.example` | `OLLAMA_CLOUD_BASE_URL` default updated to `https://ollama.com/v1` |
| `src/utils/provider-models.test.ts` | Added 2 tests for `ollamaCloud` model catalog |

## 1.1.2 — MiMo Provider & Budget Hardening

## 1.0.0 — Second Brain

This is a **major release** because it introduces the Second Brain — a persistent, structured memory system backed by SQLite with full-text search — alongside fundamental changes to how Mercury stores data and renders output.

### Why 1.0.0?

Mercury has been in rapid development through 0.x releases. The Second Brain feature represents a fundamental capability shift: Mercury now **remembers** across conversations, automatically extracting, consolidating, and recalling facts about you. Combined with the all-in-`~/.mercury/` data architecture and live CLI streaming, this marks a stable, production-ready foundation warranting a major version.

### Second Brain 🧠

- **10 memory types** — identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection
- **Automatic extraction** — after each conversation, Mercury extracts 0–3 facts with confidence, importance, and durability scores
- **Relevant recall** — before each message, injects top 5 matching memories within a 900-character budget
- **Auto-consolidation** — every 60 minutes, synthesizes a profile summary, active-state summary, and generates reflection memories from detected patterns
- **Conflict resolution** — opposing memories resolved by higher confidence or recency; negation detection handles "likes X" vs "does not like X"
- **Active → Durable promotion** — memories reinforced 3+ times automatically promote from short-lived `active` scope to long-lived `durable` scope
- **Auto-pruning** — active-scope memories stale after 21 days; inferred memories decay; low-confidence durable memories dismissed after 120 days
- **SQLite + FTS5** — full-text search for instant recall, all data stored locally at `~/.mercury/memory/second-brain/second-brain.db`
- **User controls** — `/memory` for overview, search, pause, resume, and clear in both CLI and Telegram

### CLI Streaming Restored

- **Live text streaming** — raw response tokens stream to the terminal as they arrive, then the full response is re-rendered with proper markdown formatting (headings in cyan with `■` markers, code blocks in yellow, lists with dim bullets, blockquotes with dim borders)
- **Cursor save/restore** — uses `\x1b7`/`\x1b8` ANSI sequences instead of fragile line counting, eliminating the duplicate-response bug for single-line answers
- **Tool feedback during streaming** — tool calls appear inline during streaming and are tracked for accurate output replacement

### Data Architecture: All in `~/.mercury/`

- **Before**: Memory (short-term, long-term, episodic) was stored relative to CWD at `./memory/`, creating files in random project directories
- **After**: All state now lives under `~/.mercury/` — config, soul, memory, permissions, skills, schedules, token tracking, daemon state
- **`getMemoryDir()`** helper returns `~/.mercury/memory/` — no more `memory.dir` config field
- **Auto-migration** — on first run, Mercury detects and moves any legacy `./memory/` directory to `~/.mercury/memory/`, then removes the old directory
- **Removed config fields**: `memory.dir`, `memory.secondBrain.dbPath` — these are now computed from `getMercuryHome()`

### Permission Modes

- **Ask Me** — confirm before file writes, shell commands that need approval, and scope changes (default on both CLI and Telegram)
- **Allow All** — auto-approve everything for the session (scopes, commands, loop continuation). Resets on restart.
- CLI: arrow-key menu at session start. Telegram: inline keyboard on first message, `/permissions` to change.

### Step-by-Step Tool Feedback

- **Numbered steps** — each tool call gets a step number (`1. read_file foo.ts`)
- **Spinner** — animated spinner with elapsed time while tools execute
- **Result summaries** — concise result shown after each step (e.g., `42 lines, 3 matches`)

### Other Changes

- **Improved markdown renderer** — cyan headings with `■` markers, yellow inline code, dim strikethrough, blue underlined links with dim URLs, bordered blockquotes, bordered tables
- **HTML entity decoding** — fixes double-encoding from marked's HTML output
- **Telegram organization access** — admins and members with approve/reject/promote/demote flows
- **Model selection during onboarding** — after validating an API key, Mercury fetches available models and lets you choose
- **Telegram editable status messages** — streaming updates use `editMessageText` for live response editing
- **Scheduled task notifications** — Mercury notifies the originating channel when a scheduled task runs
- **Full temporary scope for scheduled tasks** — tasks run in Allow All mode with auto-approved scopes

### Breaking Changes

- Memory data paths changed from `./memory/` to `~/.mercury/memory/` — auto-migration handles this
- Config field `memory.dir` removed — no action needed, value is ignored
- Config field `memory.secondBrain.dbPath` removed — path is now computed automatically

### Full Changelog

**0.5.4** — Fix streaming alignment, remove agent name duplication, cleaner block format
**0.5.3** — Add mercury upgrade command, ENOTEMPTY fix
**0.5.2** — Fix readline prompt handling, streaming re-render, interactive loop detection, HTML entity decoding
**0.5.1** — Bug fixes
**0.5.0** — Telegram organization access, model selection, updated docs
**0.4.0** — Social media skills, GitHub companion
**0.3.0** — Permission system, skill system, scheduler
**0.2.0** — Telegram streaming, file uploads, daemon mode
**0.1.0** — Initial release