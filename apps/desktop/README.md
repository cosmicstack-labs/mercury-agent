# Mercury Desktop

The native desktop app for Mercury: a Tauri 2 shell (Rust, small) around a
React UI built for the desktop — its own components, its own API client.
Nothing is imported from the runtime-served web dashboard. The shell owns
what a browser tab cannot (window and tray, the OS keychain, finding and
starting the runtime on this computer, deep links, updates); the UI talks
to a runtime over its HTTP API and event streams.

```
apps/desktop/
  src/api/          client (Bearer), SSE stream, endpoint map, types
  src/app/          App root, stores (view, runtime state, chat, bots), theme, events
  src/components/   ui primitives · indicators (StateOrb, Thinking, Approval, Activity) · Markdown · Logo
  src/layout/       Rail + Workspace (all views mounted, switched by state: no page loads)
  src/views/        chat · code · bots · plugins · skills · settings
  src/shell/        connections store, runtime bring-up, native bridge, first run
  src-tauri/        Rust: window, tray, keychain, local-runtime detection, installer
```

Design: one quiet palette (`src/styles/tokens.css`), light / dark / auto, a
single accent the user can tint; amber means "needs you", red means halt,
cyan means thinking — fixed. Geist and Geist Mono are bundled.

## Extending the chrome

The status bar is built from contributions (`src/extensions/registry.ts`).
Built-in items register exactly as a UI plugin will:

```ts
mercuryUi.registerStatusItem({
  id: "optimus.screen",          // "<owner>.<name>", stable
  title: "Screen control",       // shown in Customize and Settings → Status bar
  area: "status.right",          // or "status.left"
  priority: 30,                  // higher sits further left in its area
  views: ["chat", "code"],       // omit for every view
  render: ScreenStatus,          // a React component
});
```

The user's choices (hidden, shown, order) are stored by id, so adding or
removing contributions never reshuffles their layout. Keep ids and fields
stable once published; add new optional fields, never rename.

## How a connection works

| Kind   | Address                      | Credential                                              |
|--------|------------------------------|---------------------------------------------------------|
| local  | `http://127.0.0.1:<port>`    | the runtime's per-boot attach token (`~/.mercury/attach-token`), read fresh each time |
| remote | any `http(s)://` origin      | a device token (`mdt_…`) in the OS keychain, minted by `POST /api/auth/token` or `mercury devices add` |

Before the dashboard loads, the shell calls `GET /api/health` and compares
`apiVersion` with `src/shell/compat.ts`. Out of range → the user is told
which side to update and can open the runtime's own dashboard instead.

## Develop

Prerequisites: Node 22, Rust stable, and the platform bits Tauri lists at
https://v2.tauri.app/start/prerequisites/ (Xcode CLT on macOS; WebView2 +
MSVC on Windows; webkit2gtk 4.1 + libayatana-appindicator on Linux).

```sh
cd ui && npm ci && cd ..              # the dashboard's dependencies
cd apps/desktop && npm ci
npm run icons                          # once: generates src-tauri/icons from icons/source.png
npm run desktop:dev                    # Tauri window + Vite HMR
```

`npm run dev` alone serves the frontend at http://localhost:1420 in a plain
browser (native calls fall back to no-ops/localStorage); start the runtime
with `MERCURY_DESKTOP_DEV=1` so its CORS allows that origin.

## Build

```sh
npm run desktop:build                  # .dmg / .msi+.exe / .deb+.AppImage under src-tauri/target/release/bundle
```

Updater artifacts (`createUpdaterArtifacts`) are off in this config until
the signing keys exist; CI turns them on with `TAURI_SIGNING_PRIVATE_KEY`.
The update manifest the app polls is `https://mercuryagent.sh/desktop/latest.json`
(published from `website/static/desktop/`, the same path as the plugin
catalog).

## Install from the app

"Install Mercury here" (src-tauri/src/commands/installer.rs) resolves the
latest runtime release, downloads the binary for this CPU and `web.tar.gz`,
verifies both against `checksums.txt`, installs into `~/.mercury/bin`, then
runs `mercury setup --headless --owner <name>`, `mercury service install`
(optional) and `mercury start`, and attaches. Runtime releases must stay the
GitHub "latest" release: publish desktop releases with `--latest=false`.

## Not yet here

- QR pairing (`mercury://connect?...` deep link is registered; the phone
  app will emit it).
- Notifications with actions, the macOS notch capsule, auto-start toggle UI.
