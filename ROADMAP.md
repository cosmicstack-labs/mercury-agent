# Mercury — Improvement Plan (October 2026)

Scope: make Mercury a top-tier personal agent harness across macOS, Linux, Windows and
Termux, with the TUI as the flagship surface. Derived from a read-only audit of
v1.3.0 (`5aae3fb`) covering the agent loop, TUI, channels, Mercury Code, Bots,
security backlog, and the build/deploy pipeline. All `file:line` references are
against that commit.

---

## 0. Executive summary — five root causes

Most user-visible pain traces back to five things. Fix these and the product changes
character; everything else is polish.

| # | Root cause | Symptom users report | Where |
|---|---|---|---|
| 1 | **Mercury Code's guards run in plain chat.** The narration guard and verification gate fire whenever `programmingMode` is `off` and the message matches an implementation-intent regex (`mak|add|test|cod|creat|continu|proceed|do it`). | "Make me a workout plan" → up to 10 forced tool-only rounds, "getting started on the real build now…", then "I couldn't get started on this one yet." **This is the "not helpful at all" bug.** | `src/core/agent.ts:4459-4476`, `:4745-4747`; `src/core/execute-guard.ts:70` |
| 2 | **"Done" is not evidence-gated in practice.** A failed or timed-out `npm test` satisfies the verification gate (string match, not exit code); remote channels never receive the verification line; pause banners are truncated to 80 chars and deleted on Telegram. | Green "✓ Verified" over a broken build; bot "goes silent" on Telegram; permission prompts silently auto-deny after 120 s. | `execute-guard.ts:216`; `agent.ts:4707/4800/4829/5097`; `channels/telegram.ts:361-378, 680, 716` |
| 3 | **The TUI loses input and can't be interrupted.** Multi-line paste strips `\n`; no bracketed paste; Ctrl+C hard-exits, Esc does nothing; chat mode re-parses the whole streaming message as markdown every 60 ms; the Ink patch can silently fail, after which new messages stop rendering past 100. | Mangled code pastes, "it feels laggy", no way to stop a turn except `/stop`, CJK input broken (#41). | `src/ui/input-composer.tsx:250-259`; `src/ui/App.tsx:292, 681, 1705`; `package.json:23,66`; `tsup.config.ts:45` |
| 4 | **Standalone binaries ship without a working SQLite on any OS**, and Termux is mis-detected (`android` ≠ `linux`). | Second Brain silently off for every binary user (not just Linux #96); bots fall back to JSON; Termux exits after the wizard with "Unsupported platform". | `src/memory/second-brain-db.ts:15-34`, `src/bots/queue.ts:15-31`; `src/utils/platform.ts:8`; `src/cli/service.ts:495-499` |
| 5 | **Security backlog is mostly fixed but publicly "unpatched".** 8 of 13 open security issues are fixed in code and not closed; 5 CVEs + 4 GHSAs list "Patched versions: None"; no `SECURITY.md`. One **unreported** shell injection remains in `git_status/git_log/git_diff`. | Reputation risk any investor or enterprise buyer finds in minutes. | `src/capabilities/git/git-status.ts:13`, `git-log.ts:16`, `git-diff.ts:16`; `permissions.ts:477-498` |

Cross-cutting: `src/core/agent.ts` is 8,362 lines with a single 2,400-line `handleMessage`
and `onStepFinish` copy-pasted four times; 699 `any` casts; 981 `console.log`; no ESLint; no
end-to-end eval harness; 154 of 174 commits in 90 days by one person.

---

## 1. Scorecard

| Area | State | One-line verdict |
|---|---|---|
| Conversation quality | 🔴 | Guards misfire in chat; history = last 10 texts, tool results never persisted; memory injected as fake dialogue |
| Latency | 🟠 | ~10K-token uncached prefix per step; blocking channel edits per step; 3 full session-JSON reads + ~9 SQLite queries before first token |
| TUI | 🟠 | Architecture is sound (Static scrollback, diff-render); input/interrupt/paste are below par; patch shipping fragile |
| Feedback (all channels) | 🔴 | No consistent started/step/waiting/done/failed contract; evidence lost on remote channels |
| Mercury Code | 🟠 | Good ideas (completion contract, watchdog) undermined by string-match verification and a watchdog that kills long builds |
| Bots (new) | 🟠 | Solid queue design; duplicate-execution race; lead synthesis never delivered; `needsYou` volatile |
| Security | 🔴 (process) 🟠 (code) | Code mostly patched; disclosure process absent; one unreported injection; safe-read classifier is a losing regex race |
| macOS | 🟢 | Reference platform |
| Linux | 🟠 | Fine via npm; binary lacks SQLite; arm64 untested in CI |
| Windows | 🔴 | Service install broken (#13), wizard can exit silently (#64), kill = TerminateProcess, upgrade race, update check dead |
| Termux | 🔴 | Mis-detected platform; npm-only; no service |
| Engineering foundations | 🟠 | Good docs/ADRs and OS matrix in CI; no lint, no eval harness, no binary smoke tests, monolith files |

---

## 2. Priorities

### P0 — this week (release as 1.3.1 hotfix)

| # | Change | Evidence | Size | Acceptance |
|---|---|---|---|---|
| P0.1 | Gate narration guard and verification gate to `programmingMode.isExecute()` only | `agent.ts:4459-4476`, `:4745-4747` | S | "Make me a workout plan" and "write my notes to notes.md" produce a direct answer with zero forced rounds; regression test in `execute-guard.test.ts` |
| P0.2 | Verification must be `ok === true` and after the last mutation; timeout = ✗; failed verification → pause banner, never "complete" | `execute-guard.ts:216`, `agent.ts:4707/4800`, `run-command.ts:113` | S | Test: `npm test` exit 1 → no completion banner; timed-out test → ✗ |
| P0.3 | `endTask()` before terminal sends; flush deferred text; never truncate pause/failure banners | `agent.ts:4829`, `telegram.ts:361-378`, `discord.ts:445`, slack | S | Telegram test: step-budget pause arrives as a full persistent message |
| P0.4 | Fix `git_status/git_log/git_diff` shell injection: `execFileSync('git', ['-C', path, …])` + `checkFsAccess(path,'read')` | `git-status.ts:13`, `git-log.ts:16`, `git-diff.ts:16` (pattern already correct in `git-add.ts:16`) | S | Test with a path containing `"; echo pwned` |
| P0.5 | Close the 8 fixed-but-open security issues with commit refs; add `SECURITY.md`; publish advisories for the 5 CVEs / 4 GHSAs with fixed versions; CHANGELOG security entry | issues #101/#71/#77, #82/#72, #80/#76, #99/#75 (residual race noted) | S (admin) | GitHub shows a security policy and advisories with patched versions |
| P0.6 | Termux detection: `platform === 'linux' \|\| 'android'`; assert in Termux CI job | `platform.ts:8`, `index.ts:2249-2275` | S | Termux job asserts `process.platform` and that `autoDaemonize` doesn't exit |
| P0.7 | Bots: `running.has(job.id)` guard in retry/pause timers; deliver lead `mailbox` turns; make `needsYou` durable (journal row) | `bot-manager.ts:521-548, 565, 154` | S | Test: retry + due-sweep never runs a job twice; lead synthesis reaches the thread |
| P0.8 | Permission/choice prompt timeouts write the outcome back ("⏱ no answer → denied") and keep the card; `editMessageReplyMarkup` after approvals (#23) | `telegram.ts:262-275, 680, 716, 760` | S | Manual + unit |
| P0.9 | Ink patch: pin `"ink": "5.2.1"` exactly; ship `scripts/apply-ink-patch.cjs` in `files`; assert patch markers at boot and abort with a clear message | `package.json:23,66`, `tsup.config.ts:45`, `cli.ts:604` | S | Fresh `npm i --ignore-scripts` → clear error, not a silent 100-message cap |
| P0.10 | Drop minute-resolution time/budget from the system prompt (append at the end at day resolution); add Anthropic `cache_control`; log `cachedInputTokens` | `agent.ts:5201-5215` | S | Cached-token ratio visible in `completionMeta` |

### P1 — next 2–3 weeks (1.3.2 / 1.4)

| # | Change | Evidence | Size |
|---|---|---|---|
| P1.1 | **Feedback contract** implemented behind one `TaskSurface` interface used by CLI, web, Telegram, Discord, Slack, Signal (see §3C) | four divergent status-card implementations in `src/channels/*` | M |
| P1.2 | **Context builder v2**: persist compact tool-step records (tool, args head, result head) in the session; token-budgeted window with rolling summary; memory moved from fake dialogue into a system section with a score threshold | `agent.ts:3063-3065, 3110-3118, 4917-4934`; `user-memory.ts:255-266` | M |
| P1.3 | Per-step channel updates fire-and-forget + coalesced; `Promise.all` cloud pool search with memory retrieval; cache session reads per turn; batch SQLite writes | `agent.ts:3130, 3678-3739`; `sessions/repository.ts:132→458` | M |
| P1.4 | Mode-aware `activeTools`: no Spotify/GitHub/scheduler schemas in a plain chat turn (~6.5K tokens of tool schema per step today) | `capabilities/registry.ts:277` | S |
| P1.5 | TUI input: keep `\n\t`, enable bracketed paste (`?2004h`), strip `ESC[200~/201~`, Shift+Enter multi-line; grapheme-aware cursor (`Intl.Segmenter` + `string-width`); persistent history | `input-composer.tsx:250-259, 284`; `App.tsx:368, 700` | M |
| P1.6 | TUI interrupt semantics: Esc = interrupt turn, Ctrl+C = clear input / double-tap quit; prompt resolver map keyed by prompt id | `App.tsx:292, 681`; `cli.ts:1757-1845` | S |
| P1.7 | TUI perf: reuse Mercury Code's fence-aligned tail renderer in chat/coding; one shared 100 ms tick store replacing five tickers; async `readGitStateQuick`; reset log-update baseline on resize | `App.tsx:1705, 1834, 1749, 1925, 2296`; `cli.ts:2183`; patch `log-update` | M |
| P1.8 | Tool progress + abort plumbing: `run_command` streams stdout to `markProgress`, honours `abortSignal`, stall clock suspended while a tool with explicit timeout runs | `run-command.ts`, `agent.ts:397, 2278, 4345` | M |
| P1.9 | Standalone SQLite: `bun:sqlite` backend when `process.versions.bun`; `node:sqlite` fallback for toolchain-less npm installs; `mercury doctor --storage` | `second-brain-db.ts:15-34`, `queue.ts:15-31, 475`, `board-db.ts:135`, `pool-search.ts:10-12` | M |
| P1.10 | Windows: fix `installWindows` quoting + `getDistPath` via `realpathSync(argv[1])`; HKCU Run fallback for non-elevated; graceful shutdown over local HTTP instead of `process.kill`; installer waits on parent PID; `execFile('npm')` with `shell:true`; `os.homedir()` for `~` | `service.ts:59-64, 495-499`, `daemon.ts:219-223`, `index.ts:4740-4757`, `update-notice.ts:96`, `agent.ts:7168,7817` | M |
| P1.11 | Wizard robustness (#64): single readline, reject on `close`, global error handlers before `configure()` | `index.ts:152-160, 2325-2350` | S |
| P1.12 | Read-side path canonicalisation + `nlink>1` prompt + `fstat` dev/ino (#104 and symlink reads); strip `list_agents/stop_agent/delegate_task` from children by default + lineage check (#74) | `permissions.ts:477-498`; `stop-agent.ts:14-22`, `supervisor.ts:338` | S/M |
| P1.13 | `/new` on every channel (fresh session, memory kept) (#38); `/trace <id>` per-turn trace; daemon log level `info`; `mercury doctor --health` | `agent.ts:7582`, `telegram.ts:313-329`, `utils/logger.ts:5`, `index.ts:3852` | M |
| P1.14 | Provider layer: DeepSeek thinking by prefix (`deepseek-v4*`, `reasoner`), pass stored reasoning back (#24); capability tiers so fallback never silently downgrades; remove sticky `markSuccess` override; sane `maxOutputTokens` per provider; set `temperature` | `providers/deepseek.ts:14`, `providers/registry.ts:166-176`, `agent.ts:4409`, `config.ts:295/328` | M |

### P2 — this quarter (1.5)

| # | Change | Why |
|---|---|---|
| P2.1 | Split `handleMessage` into `prepareContext → generate → guards → deliver` with one shared `onStepFinish`; break `agent.ts`, `index.ts`, `App.tsx`, `cli.ts` into modules | Velocity and bus factor; every P1 item is harder inside an 8K-line file |
| P2.2 | Auto-approval **argv lane**: POSIX-tokenise, allowlisted `argv[0]`, per-command flag policy, `execFile(absBinary, argv, {env: minimal})` from a PATH pinned at startup; shell only in the approval lane. Immutable per-agent permission context (capability tokens, child ⊆ parent) | Closes the whole safe-read bypass class (#103, residual `find -fprint0`, `rg --pre`, `git --output`, `--ext-diff`) and the #99/#75 race |
| P2.3 | Replay-based eval harness: fixtures (history, message, recorded tool outputs) → mocked provider; assert no forced guard in chat, non-empty answer, verification correctness, per-phase timings; run in CI | Today nothing drives `handleMessage`; quality regressions are invisible |
| P2.4 | Vendor the patched Ink (`noExternal` + alias to `vendor/ink`), drop postinstall; upstream Yoga hygiene (`facebook/yoga#1818`) and `Static.itemKey`; real hardware-cursor positioning for IME (#41) | Deterministic TUI on every install path incl. Termux |
| P2.5 | Declarative keymap table driving `App.tsx`, `/help` and attach TUI; attach consumes `TuiState` diffs over SSE instead of reconstructing from events | Removes ~135 lines of drifting duplicate key handling |
| P2.6 | CI: Bun job per OS building the host binary and running `--version`, `doctor --platform`, `doctor --storage`; Node 24/25; linux-arm64; installer scripts against a local release dir; shellcheck/PSScriptAnalyzer; unit tests for plist/unit/schtasks generation | No binary or service path is tested today |
| P2.7 | ESLint (strict), `any` budget with a ratchet, `console.log` → logger, `files`/tarball verification test | Hygiene that compounds |
| P2.8 | Termux first-class: `~/.termux/boot/start-mercury` from `mercury service install`, `node:sqlite` path, narrow-width TUI rules (`cols`-based instead of fixed 60/50/34+56/26) | Makes the fourth platform real |

---

## 3. Workstreams (detail)

### A. Conversation quality and latency

Architecture: `enqueueMessage` (661) → `processQueue` (2383) → `handleMessage` (2805-5179) →
`buildSystemPrompt` (5181); AI SDK `streamText` with `stepCountIs(75)`, `maxOutputTokens: 32768`,
all 53 tools every step; history = last 10 `message` entries from JSON sessions; memory via FTS.

Problems and fixes, ranked:
1. Guards in chat (P0.1). Also `isTextDeliverableRequest` should short-circuit the verification gate.
2. Cross-turn amnesia: only `finalText` is stored; the `[Using: …]` loop-detector regex at 3072 scans a marker never written. Persist tool-step summaries; budget by tokens (P1.2).
3. Memory as fake dialogue, injected even with zero matches (profile fallback). System section + threshold (P1.2).
4. Uncached ~10K prefix (system ~3.8K + tool schemas ~6.5K) re-sent on up to 75 steps; prompt changes every minute. P0.10 + P1.4.
5. Blocking per-step channel edits serialise the loop (P1.3).
6. Hot path before first token: awaited cloud pool search (800 ms timeout) in series; `presentChoice` modal for ambiguous skills; Mercury Code handoff modal (45 s) on coding-looking CLI messages; 3 full session reads; ~9 SQLite queries. P1.3.
7. Non-answer endings: loop-detector aborts end with a banner and no synthesis; empty text becomes "(no text response)" and is delivered; intermediate narration is concatenated with the final answer. Fix: on abort, run one final no-tools round to summarise; never deliver "(no text response)"; separate narration stream from answer stream.
8. Provider layer (P1.14).

Metrics to add to `completionMeta` and `/trace`: prompt-build ms, memory ms, first-token ms, per-step ms, cached/uncached input tokens, guard decisions, provider switches.

### B. TUI

Architecture is right (single Ink root, `TuiState` via `useSyncExternalStore`, `<Static>` scrollback,
diff-rendered live region). The gaps are input, interrupt, perf and patch shipping.

Order: P0.9 (patch safety) → P1.6 (interrupt) → P1.5 (paste/IME/history) → P1.7 (perf) →
narrow-width rules (P2.8) → P2.4/P2.5.

UX features, in priority order once the above lands: permission prompts showing the diff/command
inline with "always for this tool"; `?` keybinding overlay and rotating status hints; Ctrl+R history
search; `/copy` via OSC 52 and OSC 8 links; real LCS diff with intra-line highlight (`tool-block.ts:133`
is prefix/suffix only); OSC 11 theme query (today `COLORFGBG` only, mis-detects Windows Terminal /
VS Code / tmux); bell when a prompt needs you; Ctrl+O expand in place.

Known-bad specifics to fix along the way: Delete acts as backspace (`App.tsx:750`); `setSlashSelIdx(0)`
effects add two commits per keystroke (`App.tsx:128,150`); 120 ms tail memo has no trailing flush
(`App.tsx:2652`); attach `streaming` only clears on `text_done`/`error` so tool-only turns show
"working…" forever (`attach-tui.tsx:207-213`).

### C. Feedback contract (every surface, every turn)

1. **started** — one line within 2 s: intent restatement + mode (chat/code/bot), edited in place.
2. **step** — `n/N · tool target · ok|err · Δt` in one live region; never a new message per step.
3. **waiting-on-you** — explicit card with options and a visible timeout; the timeout outcome is
   written back ("no answer → denied").
4. **done-with-evidence** — files changed, verification command + exit code + 1-line output tail,
   tokens/cost/time. **No "complete" without `verified.ok === true` or an explicit
   "unverified because: …".**
5. **failed/paused-with-reason** — which guard/provider/limit fired, what was preserved, the one
   command to resume; delivered as a persistent message, never a status-card notice.
6. **trace handle** — every terminal message carries an id resolvable by `/trace <id>` and the web
   cockpit.

Implement once behind `TaskSurface`; channels render, they do not decide.

### D. Mercury Code and Bots

Mercury Code: P0.2 (verification semantics), P1.8 (progress/abort so a 10-minute build isn't killed at
4 minutes with "stalled provider"), plan checklist reconciled against actual tool success instead of
model self-report (`cli.ts:1437`), `update_plan` on all channels (today CLI-only, `agent.ts:2534`),
checkpoint/undo beyond `/code diff`.

Bots: P0.7 (duplicate run race, lead delivery, durable `needsYou`), sub-agent results not sliced to
500 chars (`supervisor.ts:315`), "needs you" sends retried, retention caps verified under load.

### E. Security

Code order: P0.4 (git helpers) → P1.12 (reads, lineage) → P2.2 (argv lane + capability tokens) →
PATH pinning in service files (`service.ts:297, 398`). Windows blocklist additions: `pwsh`,
`Remove-Item`, `Set-ExecutionPolicy` (`blocklist.ts`). `.env` written with `mode: 0o600`
(`index.ts:723-734`).

Process (P0.5): `SECURITY.md` with private reporting via GitHub advisories and an SLA; advisories
published for CVE-2026-22169, -32010, -30741, -28463, -26322 and GHSA-796m-2973-wc5q,
-jccr-rrw2-vc8h, -943q-mwmv-hhvh, -qrp5-gfw2-gxv4 with fixed versions; close #101/#71/#77,
#82/#72, #80/#76, #99/#75 with commit refs; add regression tests for `find -exec`, #99/#75, #100,
#74 lineage. Until P2.2 ships, describe safe-read auto-approval as best-effort, and do not claim
"asks before it acts" for `git_status/git_log/git_diff` until P0.4 is released.

### F. Cross-platform

| | macOS | Linux | Windows | Termux |
|---|---|---|---|---|
| Install | OK | OK (glibc) | OK x64; arm64 refused | npm only |
| Service | OK | OK | P1.10 | P2.8 |
| TUI | OK | OK | P1.5/P1.6 (Ctrl+C hard-kill in `arrow-select.ts:117`) | P2.8 narrow widths |
| SQLite (binary) | P1.9 | P1.9 (#96) | P1.9 | n/a |
| Upgrade | OK | OK | P1.10 | npm |
| Channels | Signal needs Java 17+ | all | no Signal | no Signal |

Also: `install.sh:49` calls `err` before it is defined; no post-install `--version` smoke or rollback.
CI additions in P2.6. Release workflow is manual (`publish.sh`, CI publish job disabled,
`ci.yml:138-163`); binaries are built on one Mac with Bun and never executed in CI.

### G. Engineering foundations

P2.1 split, P2.3 eval harness, P2.6 CI, P2.7 lint. Keep ADRs current: add ADR-015 (feedback
contract / `TaskSurface`), ADR-016 (argv-lane auto-approval and capability tokens), ADR-017
(vendored Ink), ADR-018 (SQLite backend selection: better-sqlite3 → bun:sqlite → node:sqlite → JSON).

---

## 4. Targets

| Metric | Today (estimated) | Target |
|---|---|---|
| Forced tool rounds in plain chat | up to 10 | 0 |
| "Complete" banners with failed/absent verification | possible | 0 (test-enforced) |
| Fixed prefix tokens per step | ~10K, uncached | ≤6K, ≥80% cached on Anthropic/OpenAI |
| Time to first token (local, warm) | prompt build + 3 session reads + ~9 queries + serial pool search | < 400 ms before provider latency; measured in `/trace` |
| Pause/failure messages lost on Telegram | yes | 0 |
| Standalone binary with working Second Brain | 0 of 4 targets | 4 of 4 |
| Windows `mercury service install` | broken | works for standard users |
| Termux `mercury` after wizard | exits | runs; boot script optional |
| Open security issues already fixed | 8 | 0; advisories published |
| Tests driving `handleMessage` / `TuiApp.useInput` | 0 / 0 | eval harness + key-handling tests in CI |

---

## 5. Sequencing

- **Week 1 — 1.3.1 hotfix.** P0.1–P0.10. Mostly one-line conditions, admin, and small guards.
  Publish advisories the same day the git-helper fix ships.
- **Weeks 2–4 — 1.3.2 then 1.4.** P1.1 (feedback contract) and P1.2 (context v2) first because
  everything else renders through them; then TUI P1.5–P1.7, Windows P1.10–P1.11, SQLite P1.9,
  provider P1.14, security P1.12, `/new` + `/trace` P1.13.
- **Weeks 5–12 — 1.5.** P2.1 split (do it early in this window; later work gets cheaper), P2.2 argv
  lane, P2.3 eval harness in CI, P2.4 vendored Ink + IME, P2.6 binary CI, P2.7 lint, P2.8 Termux.

Hiring/ownership note: with one author on 90% of commits, the P2.1 split and the eval harness are
what let a second engineer contribute safely. Prioritise them over new features.

---

## Appendix — condensed findings by area

### Agent loop (`src/core/agent.ts`, `execute-guard.ts`, `providers/*`, `sessions/*`, `memory/*`)
- `handleMessage` 2805–5179; `onStepFinish` duplicated at 3473, 3917, 4563, 2430.
- Narration guard 4459–4476 (chat mode), verification gate 4745–4747; `FORCED_ACTION_TOOLS` 4545; `WORK_NOT_STARTED_BANNER`; second-wind rounds 4619.
- History 3063–3065 (10 messages, 4 in Saver); only `finalText` stored 4917–4934; dead `[Using: …]` detector 3072.
- Memory injection 3110–3118, 3161–3168; profile fallback `user-memory.ts:255-266`.
- Prompt: time/budget 5201–5215; soul+guardrails+persona ~5.8 KB; 25 skill summaries ~5.5 KB; 53 tool schemas ~25 KB incl. 14 Spotify tools always present.
- Blocking step I/O 3678 (Telegram), 3692 (Signal), 3720 (Discord), 3734 (Slack), 3739 (`[Using…]`).
- Hot path: pool search 3130; skill choice modal 3240; Mercury Code handoff 766; research prompt 752; `sessions.get` re-reads 132→458.
- Loop-detector aborts 3552–3582, 4289–4295; "(no text response)" 4445, 4882; narration concatenation `stepAwareTextStream` 103–140; auto-continue only in execute 3831.
- Providers: default `deepseek-chat` (`config.ts:295/328`); thinking only for exact `deepseek-reasoner` (`deepseek.ts:14`); sticky `markSuccess` (`registry.ts:166-176`); chain doubled 4409; `maxOutputTokens: 32768` 393; no temperature.
- Tests: 20 `core/*.test.ts`, pure helpers only.

### TUI (`src/ui/*`, `src/channels/cli.ts`, `patches/ink+5.2.1.patch`)
- Root `cli.ts:1067`; `TuiState` coalescing 712–741; token throttle 1640–1680; Mercury Code tail 32 KB / 120 ms memo `App.tsx:2645`.
- Hook census `App.tsx`: 25 `useState`, 15 `useEffect`, 6 `setInterval`; `useInput` closure 485 lines (281–766).
- Paste: `cleanPrintableInput` `input-composer.tsx:250-259`; no `?2004h`.
- IME: hidden cursor `log-update.js:9`; fake cursor `App.tsx:2130, 2430`; UTF-16 editing `input-composer.tsx:284`, `App.tsx:368, 700`.
- Patch: `tsup.config.ts:45` external; `package.json:23` postinstall `|| echo`; `scripts/` not in `files` (66); caret range; 100-message window `App.tsx:914, 1052, 2691` + ignored `itemKey` on stock Ink.
- Markdown per frame `App.tsx:1705`; tickers 1834, 1749, 1925, 2296, `use-terminal-size.ts:21`.
- Interrupt: `App.tsx:292` → `index.ts:2711`; Esc 681; resolver slot `cli.ts:1757-1845`.
- Resize vs diff-render `ink.js:91`; `readGitStateQuick` `cli.ts:2183`; fixed widths `App.tsx:2110, 938, 772-786, 1101, 2259`; attach `attach-tui.tsx:207-213, 323-457`.

### Bots / Mercury Code / channels
- Verification: `execute-guard.ts:216`; `vOk` regex `agent.ts:4707/4800`; timeout text `run-command.ts:113`; CLI-only note 5097; channel completions 4985–5065.
- Pause swallowed: `agent.ts:4829` → `telegram.ts:361-378` → `finalizeChannelTask` 2796; `discord.ts:445`.
- Watchdog: `MAX_STALL_MS` `agent.ts:397, 2278`; ambiguous end 4345; `run-command` ignores `abortSignal`.
- Bots: retry race `bot-manager.ts:521-548` vs `resumeDueJobs` 261; lead delivery 565 / `sendToBot` 370; `needsYou` 154; sub-agent slice `supervisor.ts:315`.
- Prompts: `telegram.ts:680, 716, 760`; keyboards 262–275; `statusNotices` 372 unbounded.
- `/reset` `agent.ts:7582`; Telegram commands `telegram.ts:313-329`; logger `utils/logger.ts:5`; `doctor` `index.ts:3852`; plan progress `agent.ts:2534`, `cli.ts:1437`.

### Security
- Fixed-not-closed: `permissions.ts:681` (redirection), `:686` (find flags), `:696-697` (`$`, backticks, `~`); tests `permissions.test.ts:181-262` (no explicit `-exec` case).
- Sub-agent approvals `sub-agent.ts:172-175`; shared mutable `PermissionManager` `supervisor.ts:183`; internal auto-approve window `agent.ts:2929-2933 → 5174`; `isGlobalAutoApproveActive` `permissions.ts:386-390`; "full permissions" prompt `sub-agent.ts:504`.
- Lineage: `stop-agent.ts:14-22`, `supervisor.ts:338`; `tool-filter.ts:5`.
- Reads lexical only `permissions.ts:477-498`; realpath for writes 484–492; `read-file.ts:21-38`.
- Unchecked exec: `git-status.ts:13`, `git-log.ts:16`, `git-diff.ts:16`, `git-push`; `registry.ts:244-246`; `run-command.ts:32-36` `shell:true`; PATH in `service.ts:297, 398`.
- Residual auto-approved primitives: `find -fprint0`, `find -fls`, `tree -o`, `git log --output`, `rg --pre`, `--ext-diff`.
- Process: no `SECURITY.md`; advisories unpublished; CHANGELOG security section incomplete; only `docs/security/ssrf-108-response.md`.

### Cross-platform
- Build: `tsup.config.ts:40-62` externals; `post-build.cjs`; `build-bin.cjs:75-81, 138-146, 173-207`; `verify-standalone-release.cjs` never runs a binary; `ci.yml:138-163` publish disabled; `files` `package.json:67-71`.
- SQLite in binaries: `better-sqlite3/lib/database.js:48` via `bindings`; probes `second-brain-db.ts:15-34`, `queue.ts:15-31`, `board-db.ts:135`, `pool-search.ts:10-12`; warn only `index.ts:2460-2463`.
- Windows service: `service.ts:495-499, 59-64, 95`; stop `daemon.ts:219-223`; shutdown `index.ts:3632-3666`; upgrade `index.ts:4740-4757`, `install.ps1:204-206`; update check `update-notice.ts:96`; `~` via `HOME` `agent.ts:7168, 7817`, `cli.ts:2047, 2203`, `bot-manager.ts:1387`.
- Termux: `platform.ts:8`; `autoDaemonize` `index.ts:2249-2275`; binary refused `install.sh:198`; Signal `binary.ts:32`.
- Wizard: `index.ts:152-160`, handlers 2325–2350; `.env` mode `index.ts:723-734` vs `config.ts:657`, `web/auth.ts:22`.
- `install.sh:49` `err` before definition; `install.ps1:147` arm64 refused.
- Tests: 109 files; `it.skipIf(!sqliteAvailable)` ×17; `live-region-guard.test.tsx:68`; none for `service.ts`, daemon, installers, binaries.
