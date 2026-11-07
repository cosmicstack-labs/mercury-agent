# Mercury API contract

Clients that are not shipped inside the runtime binary — Mercury Desktop,
the phone apps, scripts — talk to a runtime over its HTTP API. This page is
the ledger of that contract. Source of truth in code: `src/web/api-contract.ts`.

## Two version numbers

| Number | Where | Moves when |
|---|---|---|
| **Package version** (`1.5.0`) | `package.json`, `/api/health.version`, `mercury --version` | every release |
| **API version** (`1`) | `API_VERSION`, `/api/health.apiVersion` | only on a change a client cannot tolerate |

A client declares the API range it understands (desktop: `apps/desktop/src/shell/compat.ts`).
Additive changes never bump the integer; they add a **feature flag** to
`/api/health.features`, and clients gate UI on the flag.

## Rules

1. A removed or renamed route, a changed response shape, or a changed auth
   scheme bumps `API_VERSION`, and this table gets a row.
2. A new route, a new optional field, a new event type adds a feature flag.
   Flags are never removed without bumping `API_VERSION`.
3. The runtime is the source of truth. A client compares and either
   proceeds, tells the user to update the runtime (`mercury upgrade`), or
   tells the user to update itself and offers the runtime-served dashboard,
   which always matches.
4. No runtime release ships without checking this file.

## Versions

| apiVersion | Runtime release | Desktop | Notes |
|---|---|---|---|
| 1 | 1.5.0 (unreleased) | 0.1.0 | First contract. Device tokens, `/api/health` for authenticated remote peers, CORS for the desktop origins. |

## Authentication

| Credential | Shape | Scope | Minted by |
|---|---|---|---|
| Web session | cookie `mercury_session` or `Authorization: Bearer <token>` | any peer | `POST /api/auth/login` (form, cookie) |
| Device token | `Authorization: Bearer mdt_<id>_<secret>` | any peer, long-lived, revocable | `POST /api/auth/token` (JSON) or `mercury devices add` |
| Attach token | `Authorization: Bearer <hex>` | loopback only, rotates each boot | runtime, `~/.mercury/attach-token` |

`POST /api/auth/token` body `{ username, password, deviceName?, platform? }`
→ `{ token, device: { id, name, platform, createdAt, lastSeenAt }, apiVersion, features }`.
Ten failed attempts from one address lock it out for fifteen minutes (`429` + `Retry-After`).

`GET /api/auth/devices` → `{ devices: [...], current: <id|null> }` ·
`DELETE /api/auth/devices/:id` · `POST /api/auth/token/revoke` (sign out this device) ·
`POST /api/auth/logout` (Bearer session).

## Health

`GET /api/health` → `{ ok, pid, version, apiVersion, features, state, booting, loopLag, plugins? }`.
Loopback peers need no credential. Any other peer must present one; without it the
runtime answers `404`, so a scanner learns nothing.

## Cross-origin clients

`/api/*` carries CORS headers for `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost` and the origins listed under `web.corsOrigins` in
`mercury.yaml`. Never `*`, never credentials: cross-origin callers use Bearer
tokens, so a hostile page cannot ride the session cookie. Set
`MERCURY_DESKTOP_DEV=1` to also admit the Vite dev server on port 1420.

## Feature flags (apiVersion 1)

`auth.devices`, `chat.sse`, `chat.attachments`, `bots`, `plugins`, `mcp`, `boards`, `brain`.

## Session-scoped coding

`POST /api/chat/send` accepts `programming: "auto" | "plan" | "execute"` and
`cwd` (an existing directory). The runtime runs that turn with that session's
programming mode, plan and folder, then restores the global mode and folder,
so a coding session never changes Chat, the terminal or other sessions. A plan
made in a session stays with it for its next turn.

`POST /api/chat/send` returns sent files as `attachments: [{ name, kind, mime, url }]`,
threads return them per message, and `GET /api/chat/uploads/:month/:file`
serves them to an authenticated caller.
