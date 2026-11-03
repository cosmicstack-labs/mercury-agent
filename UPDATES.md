# Updates: how Mercury and Mercury Desktop update (contract)

One signed file says what's current, what's required and what to tell people.
The server and the desktop app each read it, update themselves without breaking,
and roll back on their own when the new version doesn't come up.

## 1. The update manifest

`https://mercuryagent.sh/updates/manifest.json` (source: `website/static/updates/manifest.json`)
and its signature `manifest.json.sig` beside it. Fallback mirror:
`https://raw.githubusercontent.com/cosmicstack-labs/mercury-agent/main/website/static/updates/manifest.json` (+ `.sig`).

The signature is a minisign signature in the exact format `tauri signer sign` writes
(base64 of the `.minisig` text), made with the same key that signs desktop update
packages. The public key is the `plugins.updater.pubkey` of
`apps/desktop/src-tauri/tauri.conf.json`; the runtime has the same string in
`src/updates/public-key.ts`.

Rules for readers:
- A manifest whose signature doesn't verify is **ignored** (fall back to the plain
  version look-ups: GitHub releases / npm). Never trust an unsigned "required".
- Anti-replay: keep the highest `issuedAt` seen; a manifest with an older `issuedAt`
  is ignored.
- Fail open: no manifest (offline, blocked) never blocks the app.
- Cache: refetch at most every 6 hours (a manual "Check for updates" bypasses it, at most once a minute).

```jsonc
{
  "schema": 1,
  "issuedAt": "2026-11-03T12:00:00Z",
  "server": {
    "channels": {
      "stable": {
        "version": "1.5.0",
        "date": "2026-11-04",
        "notes": "markdown — what's new, shown before and after updating",
        "notesUrl": "https://github.com/cosmicstack-labs/mercury-agent/releases/tag/v1.5.0"
      },
      "dev": null
    },
    // Below this version you must update. null = nothing required.
    "minimum": { "version": "1.4.2", "severity": "security", "reason": "Fixes …", "since": "2026-11-03" }
  },
  "desktop": {
    "channels": { "stable": { "version": "0.2.0", "date": "…", "notes": "…", "notesUrl": "…" } },
    "minimum": null
  },
  "messages": [
    {
      "id": "2026-11-launch",            // dismissals are remembered by id
      "title": "Mercury 1.5 is here",
      "body": "markdown",
      "level": "info",                    // info | warning | critical
      "apps": ["desktop", "server"],      // who shows it
      "versions": "<1.5.0",               // optional; space-separated comparators (>=, >, <=, <, =), all must hold
      "startsAt": null, "endsAt": null,   // optional ISO dates
      "link": { "label": "Read more", "url": "https://…" },
      "dismissible": true                 // false only for critical
    }
  ]
}
```

`severity`: `security` | `required`. A "required" update is a **force update**: the
app shows a full screen that can't be dismissed, with a way out that takes
ticking every risk box (desktop); the server shows it in the CLI, doctor and on
every client.

## 2. Server update API (runtime)

Feature flag `updates` in `/api/health` `features`.

`GET /api/updates` (any signed-in client):
```ts
{
  current: string,                 // running version
  channel: 'stable' | 'dev',
  install: 'binary' | 'npm' | 'source' | 'unknown',
  canSelfUpdate: boolean,          // false for source checkouts / unknown installs
  cannotReason?: string,
  latest: { version, date?, notes?, notesUrl? } | null,
  updateAvailable: boolean,
  required: { version, severity: 'security'|'required', reason } | null,  // current < minimum
  manifestVerified: boolean,
  checkedAt: number | null,
  job: UpdateJob | null,           // the running or last job
  blocked: { version, failures, lastError } | null,  // 3 failed attempts at this version: stop retrying on our own
  justUpdated: { from, to, at } | null,              // set after a successful update, for "what's new"
  messages: Message[],             // server-audience messages that apply to this version
}
```

`POST /api/updates/check` → same body, refreshed (rate limited to once a minute).

`POST /api/updates/server` `{ version?: string, now?: boolean }` → 202 `{ job }`.
This computer: allowed. Remote device: owner approval (428, `requireOwner` id
`server.update`). 409 `{ job }` while a job runs. `now: true` skips waiting for
running work to finish.

`POST /api/updates/server/cancel` → only before the old version is stopped.

```ts
type UpdateJob = {
  id: string,
  from: string, to: string,
  state: 'waiting-idle' | 'downloading' | 'verifying' | 'backing-up' | 'stopping'
       | 'installing' | 'starting' | 'checking'
       | 'done' | 'rolled-back' | 'failed' | 'cancelled',
  percent: number | null,          // overall 0–100
  bytes?: number, total?: number,  // download
  message: string,                 // human sentence for the current step
  startedAt: number, updatedAt: number,
  error?: string,
  log: string[],                   // last 40 lines
  attempt: number,
}
```

The daemon waits for running work (up to 10 minutes; `now` skips), downloads
(resumable, verified), backs up, then hands over to a detached worker process
that stops the daemon, installs, starts it and checks `/api/health` reports the
new version. Health doesn't come back in 90 s → restore the old version and
config, start it, `rolled-back`. The job lives in `~/.mercury/updates/job.json`
so the new (or restored) daemon serves it; clients poll `GET /api/updates`
(the daemon is down for a few seconds in between — keep polling `/api/health`).

## 3. Desktop app

The desktop checks itself (Tauri updater, resumable download in Rust, minisign
verified), reads the manifest (verified in Rust), and asks every connection's
`GET /api/updates`. Top-right **Update** button (Chrome-style: colour rises
with age; red and permanent when required), an updates panel with notes before
you update, a force-update screen, a "What's new" toast after any update, and
manifest messages.
