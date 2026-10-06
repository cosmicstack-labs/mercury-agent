# Release v1.3.0

## ☿ Mercury Agent v1.3.0 — Mercury Bots

Mercury stops being one agent and becomes **a fleet**. This release introduces **Mercury Bots** — persistent, persona-scoped agents that run *outside your conversation*: each with its own persona, private sandbox workspace, skill library, permission scopes, token budget, and a durable job queue. Onboard a researcher, a writer, a watchtower — chain them into multi-level fleets where a lead bot recruits and manages its own crew. They work 24/7, stream their thinking into their own threads, and escalate only what truly needs you.

### What's New

- **Persistent bot runtime** — Bots are long-lived persona agents, not temp sub-agents: `bot.yaml` manifest + `permissions.yaml`, private sandbox at `~/.mercury/bots/<id>/`, journal-backed thread history that hydrates on reopen. A wake turns them on; they work through a durable job queue that survives restarts.
- **Fleets — leads + crews** — Promote any bot to **fleet lead**; it recruits, organizes, and manages its own crew (imperative self-organization). Multi-level hierarchies supported; crew results bubble up through the lead. Onboarding tiers: solo → lead auto-build → lead manual.
- **Durable queue + DLQ** — Jobs survive restarts, lease-heartbeat while running, classify to `timed out` on worker death, and replay non-destructively from the DLQ (`/bots replay`). Nothing dies silently.
- **Web cockpit** — The local dashboard gained a **Mercury Bots section**: live roster states, per-bot threads, needs-you escalation badges, and a fleet step view that mirrors the TUI.
- **Sandbox + deliverables** — Per-bot isolated workspace; final artifacts go out via `bot_deliver`; retention janitor caps disk; fleet-shared folder for cross-bot files with implicit grants.
- **Bundles** — `/bots export` produces a shareable bundle (manifests + personas + permissions + skills; a lead's bundle carries its whole crew). `/bots import` recreates bots — imported bots start **disabled** by design; sandbox, journals, and `.env` never travel.
- **Permission tiers at onboarding** — `ask` / `allow` per capability, set explicitly. Per-bot shell allow-lists flow from `permissions.yaml autoApproveCommands`; malformed scopes skip + warn, never crash turns.
- **Bot-facing tools** — `dispatch_bot`, `bot_schedule`, `bot_deliver`, `fleet_status`, `journal_append` + native/per-bot skill libraries with auto-synthesis. Bots can schedule their own future runs.
- **`mercury bots` CLI** — `doctor` (exit 1 when actionable), `list`, `storage`.

### Fixed

- Fleet duplication on reopen; `/bots` stays inside the bot thread it opened.
- Bot thinking streams live into its thread; fleet speed fixes (single-provider lease wait, batched roster fetches).
- Bot-thread results no longer sliced at 800 chars; durable retries + durable mailboxes close delivery-contract gaps.
- Windows hardening: SQLite queue teardown EBUSY, heartbeat-test EBUSY, retention EINVAL, separator-agnostic traversal guard; post-close queue ops degrade to no-ops.
- JSON backend lease-expiry race closed; doctor flags routines registered in schedules but missing from `bot.yaml` (the silently-never-fires failure).
- Telegram member installs no longer surface `install_skill`.

### Upgrade

**npm:**
```
npm install -g @cosmicstack/mercury-agent@1.3.0
mercury restart
```

**Standalone binary:** re-run the one-line installer from mercuryagent.sh, then `mercury restart`.

No config migrations. Bots are opt-in: `/bots create <id> "Name" "Description"` onboards your first bot.

### Files Touched (highlights)

- `src/bots/*` — the entire fleet module (new): store, queue (SQLite+JSON), bot-manager, bot-turn, journal, bundle, doctor, persona-template, fleet-*, skill-synthesis, retention, tools/.
- `src/core/agent.ts`, `src/cli/*`, `src/channels/cli.ts` — /bots chat surface, CLI command group, bot-thread region, thinking streams.
- `src/web/*` — Mercury Bots cockpit section on the dashboard.
- PRs: #131–#139, #117 (RevShare).

**Full Changelog**: https://github.com/cosmicstack-labs/mercury-agent/compare/v1.2.7...v1.3.0