# Asks before it acts: how Mercury's permission model works

> How Mercury's permission model works: scopes, approvals, a blocklist nothing overrides, an SSRF guard, and the limits that apply to unattended bots.

Published 2026-10-09 by Mercury Engineering. Tags: product, security.
Canonical: https://mercuryagent.sh/blog/asks-before-it-acts

Giving a language model a shell is easy. Giving it a shell and still being able to sleep at night is the actual product.

Mercury can read and write files, run commands, push to git, call the GitHub API and fetch web pages. Every one of those goes through the same question first: is this allowed, and if it isn't obviously allowed, has a person said yes? This post explains the layers that answer it, in the order a request hits them.

## The rule underneath everything

The model never decides what it's allowed to do. It can ask to run `npm test` or write a file, but the decision happens in ordinary code, outside the model, before anything touches your machine. Prompt injection can change what the model *asks* for. It can't change the code that answers.

Everything below is that code.

## Layer 1: a blocklist nothing can override

Some commands are never run, no matter which mode you're in, who's asking or what you approved earlier. `sudo` is one. Recursive deletes of the root or home directory are another, in every spelling we've seen: `rm -rf /`, `rm -fr ~`, `rm -rf /*`, and their PowerShell equivalents like `Remove-Item -Recurse -Force C:\` with the flags in any order.

The list is matched against each segment of a command. Mercury splits pipelines, chains and command substitutions apart first, and anything it can't fully decompose is treated as needing approval, so wrapping a blocked command in `$( )` or chaining it after `&&` doesn't hide it. It's deliberately short. A blocklist can't make an agent safe on its own. What it can do is make sure the handful of truly unrecoverable commands are off the table even in the most permissive configuration.

## Layer 2: scopes

File access is scoped to folders, and each scope is either read-only or read-write. Out of the box Mercury can read and write in the directory it's working in, and nothing else. If a task needs another folder, Mercury asks, and you can grant it for that one request or permanently.

A short list of read-only commands runs without a prompt, because asking every time someone types `ls` trains people to click *Allow* without reading: things like `ls`, `cat`, `pwd`, `git status`, `git diff` and `git log`, plus `npm test` and `npm run`.

Scopes apply to shell commands too. If a command writes to a path outside your granted scopes, Mercury treats it the same as a file write outside them.

Scopes are per channel and per role. If you share a Telegram group with Mercury in it, members can talk to the agent, but they can't install skills or widen what it's allowed to touch. Those decisions stay with admins.

## Layer 3: asking

When something isn't covered by a scope, Mercury asks. In the terminal you get an arrow-key prompt. On Telegram you get buttons. In the web dashboard you get a card with *Allow*, *Always allow* and *Deny*. The prompt says exactly what will happen: the command, the file path, the folder being requested.

You choose the default per session:

- **Ask Me** prompts for every write and every command outside your scopes. Even when a scope already covers a folder, writes in Ask Me mode still prompt.
- **Allow All** runs without prompting, inside the blocklist.

One detail we're careful about: Allow All applies to the session where you turned it on. A request that arrives from a different channel doesn't inherit your permissive setting. If you said "allow all" in your terminal, a message from a Telegram group is still checked as a Telegram message.

### Two more places that always ask

Allow All doesn't cover everything. Two exceptions were added after this model was first written:

- **MCP tools.** Mercury can use tools from Model Context Protocol servers. Every MCP call asks first in Ask Me mode, and Allow All doesn't skip that prompt. A shell command that changes the MCP setup, or writes `mercury.yaml`, `.env` or `permissions.yaml`, also asks, even under Allow All. The only exception is a single tool you have listed under `tools.autoApprove` for that server.
- **Remote devices.** Mercury listens only on `127.0.0.1`. A request counts as local only when it comes from that address with no proxy headers and a `localhost` host. Anything else is remote. A new remote device needs your approval before it can connect, and sensitive actions from it ask you each time, including the terminal, Allow All, and restarts. Devices unused for 30 days stop working until you approve them again.

## Layer 4: the network

`fetch_url` is how Mercury reads the web, and it's a classic way to attack a self-hosted service: ask the agent to fetch `http://192.168.1.1/admin`, or a public URL that redirects to one, and it becomes a proxy into your home network.

So every fetch is checked before it connects:

- Only `http` and `https`.
- The hostname is resolved, and if any address in the answer is private, loopback or link-local, the request is refused. A resolver that returns one public and one private address doesn't get the benefit of the doubt.
- The connection is pinned to the address that was checked. A hostile DNS server can't hand Mercury a public address for the check and a private one for the actual request.
- Redirects are followed manually and each hop is checked again, up to five.

Responses are also size-capped, so a page can't flood the model's context.

## Layer 5: bots that can't ask

Mercury Bots run unattended. A bot working at 3 a.m. has nobody to ask, so for bots the rule flips: **anything not explicitly granted is denied.** A missing permission isn't a question, it's a no.

When you create a bot you pick a tier:

| Tier | What it can do |
|---|---|
| **Read-only** (the default) | Browse, search, read files, message other bots. No commands, no writes. |
| **Builder** | Also create and edit files inside its granted folders. Still no shell. |
| **Operator** | Also run commands, restricted to its granted folders. The blocklist still applies. |
| **Full access** | Everything, including deleting files. Meant for automation you fully trust. |

Each bot also has its own folder scopes, its own daily token budget, and its own memory. A bot's tier is a ceiling: a crew member can't do more than the permissions it was given, regardless of what its lead asks it to do. Bots also get no MCP tools at all, whatever their tier.

## Layer 6: secrets stay out of the conversation

API keys live in `~/.mercury/.env`, not in the main config file, and the logger redacts anything that looks like a key or token before it's written. The web dashboard binds to `127.0.0.1` only, and its first password is randomly generated and shown once, so there's no default credential from the public source code that works on every install.

## What this doesn't protect you from

It's worth being direct about the limits.

If you choose Allow All and give Mercury write access to your home folder, it can do a lot of damage inside the blocklist, because you told it it could. Skills from the community registry are not audited, and a skill's instructions become part of what the model reads, so review them before installing. And no permission system makes a model's judgement correct. Mercury can still decide to do the wrong thing. The permission layers decide whether it's allowed to, and give you the chance to say no.

## Where to read more

The [permissions reference](/docs/reference/permissions) documents every setting. If you find a way around any of this, please report it privately through our [security policy](https://github.com/cosmicstack-labs/mercury-agent/security/policy). Reports from the community have already closed real issues in this area, and we credit everyone who sends one.
