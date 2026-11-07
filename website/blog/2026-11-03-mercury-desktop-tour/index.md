---
slug: mercury-desktop-tour
title: "A tour of Mercury Desktop: one app, every Mercury you run"
description: "What's inside Mercury Desktop 1.5.0: chat, research, code, bots, memory and voice, plus connecting to several Mercury servers and keeping them all updated."
authors: [mercury-eng]
tags: [product, releases]
image: ./cover.jpg
keywords: [mercury desktop, ai agent desktop app, self-hosted ai agent, multiple servers, mercury 1.5, remote agent, open source ai app]
draft: false
---

Mercury Desktop is the app we wanted every time we opened a terminal just to talk to Mercury. It ships in [1.5.0](/docs/releases/1.5.0) for macOS (Apple Silicon and Intel), Windows and Linux, and it does two jobs: it runs Mercury on the computer you're sitting at, and it connects to the Mercury you run somewhere else. Most of us end up with both, a laptop and a box in a cupboard or a small VPS, so the app is built around more than one Mercury from the first screen.

This post walks through what's in it. If you only want the file, it's on the [download page](/download).

{/* truncate */}

## The first screen: install here, or connect elsewhere

On first launch the app looks for Mercury on this computer. If one is running, it connects with the machine's local token and you're in.

If there isn't one, **Install Mercury here** downloads the release for your CPU, checks it against the release's SHA-256 checksums, and runs it as a login service, so it's there after a restart. There's no terminal and no Node.js to install.

**Connect elsewhere** takes the address of a Mercury on another machine. The app asks that Mercury for a device token, and the request waits for the owner: a 5-character code arrives on your Telegram or WhatsApp, or shows in `/server` on that machine, and you approve it there. The app never sees a password, and you can revoke it from either side. [Remote access & security](/docs/desktop/remote-access) explains the rules.

## Several Mercurys, one app

Every connection you add stays in the app. The top bar shows which Mercury this window is talking to and its version. Click it to switch, between your laptop's Mercury and the one on the VPS, for example. Tokens for remote connections live in the operating system's keychain, not in a settings file.

Each connection is checked for updates on its own. If the server in the cupboard is a version behind, the Update button in the top right says so, and the updates panel has a row for the app and one per server. **Update server** starts the update on that machine. From a remote device the owner approves it first, like any other sensitive action. The server waits for running work to finish, backs up, installs, and checks the new version starts. If it doesn't, the old one comes back on its own.

Settings → About has **Check for updates**, which asks the app and every server at once, and **Update everything** when there's more than one to do. [Updating Mercury](/docs/desktop/updating) has the details.

## Chat

Chat is where most time goes, so it got the most work.

- **Commands and skills in the composer.** Type `/` for commands and `#` for skills, from the same catalog the terminal uses, filtered to the ones that make sense in the app. A picked command becomes a chip you can see before you send.
- **Attachments.** Photos and PDFs go straight into the conversation.
- **Ask Me or Allow All**, shown the same way everywhere, so you always know whether Mercury will stop and ask before it acts.
- **Saved chats** open from a bookmark beside search.
- **Honest waiting.** A server runs one turn at a time. If another chat is mid-reply, yours says *Waiting* and names the chat it's waiting for, instead of pretending to think. You can open that chat or ask for yours to go first.

## Research you can watch

Ask for research and you get one visible run instead of a long silence. Mercury proposes a plan you can approve or edit. While it works, a checklist shows each step, every source it read, and the ones that failed with the reason, such as a timeout or a page that refused it.

You can say **Write the report now** at any point. If a run is cut short, you still get a report built from what it found, with what's missing listed at the end. Reports open in the app, export as PDF or Word, and show each source's site icon. Like everything Mercury makes, the files land in `~/mercury-artifacts`, one folder per chat, not loose in your home folder. The **Artifacts** view lists them.

## Code

**Code** is a workspace per project. Pick a folder and the chat in that project works in programming mode, with a panel beside it for the file tree, the git status of your changes, and the diff of any file you click. It's for reading along while Mercury works, not a replacement for your editor.

## Bots

Bots are Mercury instances with their own persona, tools and sandbox that run on a schedule or on demand. The app is now where you manage them:

- **An inbox of results.** Every run closes with a report: what it did, what it made, and what it needs from you.
- **Create and edit bots in words.** Describe the job and the persona builder drafts it, or let Mercury decide the whole setup.
- **Fleets.** Design the crew for a lead bot yourself, or let Mercury propose one.
- **Questions mid-run.** When a bot needs permission, the question appears with **Allow once**, **Always allow** and **Deny**, instead of the run failing.

## Brain

**Brain** shows what Mercury knows. Memories lists what it has learned about you and how you work, and you can correct anything that's wrong. People shows the people it knows from your conversations. Map groups your notes into topics, and Graph shows how people and notes connect.

## Plugins and voice

Plugins install from **Plugins**, with their setup on one page. With the [Optimus plugin](/blog/how-optimus-works), Mercury can use your computer, by chat or out loud. When Optimus is listening or speaking, a small capsule drops from the top centre of the screen, from the notch on Macs that have one. It stays above full-screen apps without stealing focus. The microphone picker, the permission checks and a live test sit at the top of the plugin page on every OS.

## What isn't there yet

This first release isn't code-signed with an Apple or Windows certificate, so a downloaded installer asks once before the first launch. The [download page](/download#first-open) shows the clicks. On a Mac you can skip that: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh` checks the download and installs the app, and it opens straight away. Updates are signed with Mercury's update key and checked before they install, so after that first launch you're covered.

A Mercury server still answers one chat at a time. Running several turns side by side is the next change to the runtime.

The app is open source like the rest of Mercury, in [`apps/desktop`](https://github.com/cosmicstack-labs/mercury-agent/tree/main/apps/desktop). If something in it gets in your way, [open an issue](https://github.com/cosmicstack-labs/mercury-agent/issues).

https://github.com/cosmicstack-labs/mercury-agent
