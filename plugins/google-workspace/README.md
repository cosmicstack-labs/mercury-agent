# Google Workspace: read and prepare drafts

An optional, dependency-free Mercury plugin for Gmail and Google Calendar.
It searches and reads messages and events, includes links to the originals,
and prepares **local, unsent `.eml` drafts**. It does not save drafts in Gmail,
send email, modify calendars, or request write access to Google.

## Install

From a Mercury source checkout, with Mercury 1.5 or newer installed:

```sh
mercury plugins validate ./plugins/google-workspace
mercury plugins install ./plugins/google-workspace
```

No npm install or build is needed inside the plugin. To distribute the same
plugin as a checked archive and checksum:

```sh
mercury plugins pack ./plugins/google-workspace --out ./release/google-workspace
mercury plugins install ./release/google-workspace/google-workspace-0.1.0.tgz
```

Use the archive filename printed by `pack` if it differs. This plugin is
installed explicitly; it adds no dependencies or tools to a default Mercury
installation. Disable or remove it through `/plugins google-workspace`.

## Connect

1. In [Google Cloud](https://console.cloud.google.com/apis/library), enable
   the Gmail API and/or Google Calendar API for your own project.
2. Configure the OAuth consent screen, including your account as a test
   user when the app is in testing. Create an OAuth client of type
   **Desktop app**. This is not a Web application client or a service account.
3. In `/plugins google-workspace`, enter the client ID and, if issued, its
   client secret. Mercury stores the client secret with its other secrets.
4. Run one of these in Mercury chat:

   ```text
   /google connect gmail
   /google connect calendar
   /google connect both
   ```

5. Open the returned link in a browser **on the computer running Mercury**.
   Choose your Google account and review the requested read-only services.
   The callback tab confirms success. Run `/google status` to see the
   services actually granted. Partial consent enables only those services.

The login uses a random loopback port bound only to `127.0.0.1`, fresh
state and S256 PKCE, and expires after five minutes. No account is connected
until Google's token exchange succeeds. `/google cancel` closes a pending
login. Disabling the plugin also closes it. Remote Mercury deployments need
a browser on that host or an explicitly configured SSH loopback tunnel;
there is no public callback listener or copy/paste authorization-code flow.

This first version connects one Google account. To change accounts or add
another service, run `/google disconnect`, then connect with the desired
service selection. Google does not support incremental authorization for
installed Desktop apps, so the plugin uses explicit re-consent instead.

`/google disconnect` removes local credentials and attempts to revoke the
Google grant. If revocation cannot be confirmed, it says so and links to
[Google account connections](https://myaccount.google.com/connections) for
manual removal. Google revocation can affect other grants using the same
OAuth project. Local unsent drafts remain until you delete them or purge
the plugin's data.

Google's testing-mode token lifetimes, restricted Gmail-scope verification,
and Workspace administrator policies still apply. Reconnect if Google
expires or revokes the refresh token. No Google credentials are included in
this package.

## Use

Examples:

- “Search my Gmail for the latest message from Alex about the launch, read
  it, and link the source.”
- “Show my calendar events tomorrow in America/New_York and link each event.”
- “Prepare a local email draft to alex@example.com with this summary. I'll
  review and send it myself.”

| Tool | Behavior |
| --- | --- |
| `google-workspace__gmail_search` | Gmail search syntax; up to 20 IDs and source links per page. Use the returned `nextPageToken` for more results. |
| `google-workspace__gmail_read` | Exact message ID; headers, snippet, and up to 20,000 characters of inline plain text. No HTML rendering or attachment downloads. |
| `google-workspace__calendar_events` | List/search one calendar in an explicit RFC3339 time range with timezone offsets. Expands recurring events; up to 20 per page. Defaults to `primary`. |
| `google-workspace__calendar_read` | Exact calendar and event IDs; bounded details and source link. |
| `google-workspace__prepare_draft` | Approval-gated local `.eml` creation, up to 20 plain ASCII recipients and 32,000 body characters. No Google connection required. |

Messages and events are labelled untrusted source material, not instructions.
Truncation and omitted bodies are disclosed. Calendar list details also have
a per-event budget, preserving every result ID and the pagination token;
use `calendar_read` for details marked truncated. Every network response is
limited to 2 MiB. A large message can exceed that limit; open its source
link instead. Gmail links use the browser's first signed-in Gmail account;
switch to the connected account if the browser has several accounts.

Drafts are saved under
`$MERCURY_HOME/plugins/google-workspace/data/drafts/` (normally
`~/.mercury/plugins/google-workspace/data/drafts/`). The tool returns the
file path. Open it in a mail client that supports `.eml`, or copy the
reviewed content into Gmail yourself. Mercury never reports it as sent or
as a saved Gmail draft. The plugin has no send tool.

## Permissions and storage

- Gmail requests only `gmail.readonly`; Calendar requests only
  `calendar.events.readonly`. Choosing Calendar alone never requests Gmail.
  Gmail's `gmail.compose` also grants send access, so it is not requested.
- Outgoing requests use Mercury's `ctx.fetch` host allowlist and SSRF guard.
  Only `oauth2.googleapis.com`, `gmail.googleapis.com`, and
  `www.googleapis.com` are declared. The loopback server only receives the
  OAuth redirect; it is not used to bypass the outbound network guard.
- Tokens live in the plugin's data directory with atomic replacement,
  directory mode `0700`, and file mode `0600` on POSIX. They are local
  plaintext protected by filesystem permissions, not an OS keychain;
  Windows users must restrict the Mercury home directory's ACL. Protect
  backups of this directory as credentials. No tokens or Google content
  are logged. Read results remain subject to Mercury's normal chat history.
- Token refresh is serialized. Disconnect/disable prevents an in-flight
  refresh or login from restoring credentials. A 401 read gets at most one
  refresh and retry; other errors are surfaced without background retries.
- Local draft writes use Mercury's existing plugin approval gate and
  exclusive random filenames. Bots still require explicit plugin allowlists.

## Verification

```sh
npx vitest run plugins/google-workspace.test.ts
```

The tests use fixture Google responses, a real loopback callback, Mercury's
plugin runtime, package conformance checks, and the real approval wrapper.
They cover state/PKCE, denied consent, refresh/revoke failures, disconnect
races, scoped reads, response limits, safe MIME output, and denied writes.
They do not sign into a real Google account or send any messages. A live
consent/refresh/read smoke test remains necessary with your OAuth project.

Official API contracts used:
[Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[message read](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).
