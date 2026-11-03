---
slug: mercury-1-5
title: "Mercury 1.5: Mercury Desktop"
description: "Mercury 1.5.0 ships Mercury Desktop for macOS, Windows and Linux, remote access the owner approves, and updates that roll back on their own."
authors: [mercury-eng]
tags: [news, releases]
image: ./cover.jpg
keywords: [mercury desktop, mercury 1.5, ai agent desktop app, self-hosted ai agent, remote access, auto update rollback]
draft: false
---

Mercury 1.5.0 is out, and with it Mercury Desktop: an app for macOS (Apple Silicon and Intel), Windows and Linux. It installs Mercury on your computer without a terminal, or connects to a Mercury you already run on a server. The same release changes how other devices reach your Mercury, and how both the app and the runtime update themselves.

[Download Mercury Desktop](/download), or read the [release notes](/docs/releases/1.5.0).

{/* truncate */}

## The app

The first screen looks for Mercury on your computer. If it finds one, it connects. If it doesn't, **Install Mercury here** downloads the release for your machine, checks it against the release's SHA-256 checksums, and runs it as a service. **Connect elsewhere** adds a Mercury on another machine, and you can keep several connections and switch between them.

Inside are chat, a coding workspace per project, research with live progress, bots and their results inbox, and notifications when something needs you. [Install & first run](/docs/desktop/mercury-desktop) covers the details, and [a tour of Mercury Desktop](/blog/mercury-desktop-tour) walks through every part of it.

One honest caveat: this first release isn't code-signed with an Apple or Windows certificate. macOS and Windows ask once before the first launch, and the [download page](/download) shows the clicks. Updates are a different matter. Each one is signed with Mercury's update key and checked before it installs.

## Other devices now need your approval

An app that connects to a Mercury somewhere else made us look hard at how remote access worked, and it wasn't good enough. Mercury listens only on `127.0.0.1`, so a remote device reaches it through a tunnel or proxy on the same machine. Those connect from `127.0.0.1` too, and several "this computer only" checks trusted that address. Through a tunnel, a device with a token could do what you can do at the keyboard, including open a shell.

In 1.5.0, a request counts as local only when it comes from `127.0.0.1` with no proxy headers and a `localhost` host. Everything else is remote, and remote devices work under your rules:

- A new device needs your approval. It shows a 5-character code, and you answer `approve K7Q2M` from Telegram or WhatsApp, from the terminal, or in Mercury Desktop on your computer.
- Sensitive actions from a remote device ask you each time: the terminal (off for remote devices unless you turn it on), Allow All, the workspace folder, powerful bots, plugins, channel tokens, restarts and the password.
- Devices unused for 30 days are signed out, revoking one cuts its open connections, and a device connecting from a new address tells you.

`/server` in the terminal, or `mercury server` in a shell, manages all of it, and `mercury doctor --security` checks your setup. The design is in [ADR-035](https://github.com/cosmicstack-labs/mercury-agent/blob/main/DECISIONS.md), and [Remote access & security](/docs/desktop/remote-access) explains how to use it.

## Updates that put things back

Updating used to mean `mercury upgrade`, which removed the npm package before installing the new one, kept no backup, and didn't check that the new version started. Now an update, from the app or the terminal, does this:

1. Waits for running work to finish, for up to 10 minutes.
2. Downloads the new version, resuming if the connection drops, and checks its checksums.
3. Backs up the current program and Mercury's settings.
4. Stops Mercury, installs, starts it, and waits for it to answer as the new version.
5. If it doesn't, puts the old version and settings back and starts that.

We ran this for real on a test install before the release. Updating 1.4.1 to the published 1.4.2 worked and Mercury was back in about four seconds. The first attempt, though, rolled back: the 1.4.2 binary reports an empty version on its health endpoint, so the check never matched. The updater now asks the installed program for its version when that happens. A deliberately broken release also kept Mercury offline for the full 90-second wait, so the updater now notices a crashed start and rolls back in about 15 seconds.

Mercury Desktop shows an Update button at the top right, like Chrome's. It gets more noticeable the longer an update waits, and one panel covers the app and every server it connects to. You can read what's new before you update. When an update has to happen, for a security fix, the app says so on a screen you can only get past by ticking a short checklist, and only for a while. [Updating Mercury](/docs/desktop/updating) has the whole picture.

## Also in 1.5.0

- **Research you can watch.** A plan you can edit, every source read or failed with the reason, and a report even when a run is cut short. Reports export as PDF or Word.
- **Files in one place.** What Mercury makes goes in `~/mercury-artifacts`, one folder per chat.
- **MCP servers.** Mercury can use tools from Model Context Protocol servers, and every MCP call asks first in Ask Me mode. See [MCP Servers](/docs/integrations/mcp).
- **Bots 2.0.** Each run reports, says there was nothing new, or says it failed, and results wait in an inbox.

Update with `mercury upgrade`, or [download Mercury Desktop](/download) and let it update your Mercury for you.

https://github.com/cosmicstack-labs/mercury-agent
