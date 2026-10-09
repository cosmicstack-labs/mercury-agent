# Security Policy

Mercury is a local-first agent that can run shell commands, edit files and talk to
chat channels on your behalf. We take reports about its permission model seriously.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.3.x (latest) | Yes — security fixes land here |
| 1.2.x and older | No — please upgrade (`mercury upgrade` or `npm i -g @cosmicstack/mercury-agent@latest`) |

Fixes ship as patch releases on the current minor line only.

## Reporting a vulnerability

Please do **not** open a public issue for anything exploitable.

1. Preferred: GitHub private vulnerability reporting —
   https://github.com/cosmicstack-labs/mercury-agent/security/advisories/new
2. Fallback: email **salman@cosmicstack.ai** with "Mercury security" in the subject.

Include the version (`mercury --version`), the channel or surface involved, steps to
reproduce (a deterministic harness or stub provider is ideal), and your assessment
of impact. Tell us how you would like to be credited.

## What to expect

- Acknowledgement within **3 business days**.
- For High/Critical reports: a fix or a concrete mitigation plan within **14 days**,
  and a patch release as soon as it is verified.
- For Medium/Low reports: a fix in the next regular release, normally within 60 days.
- We will keep you updated, credit you in the advisory and changelog unless you
  prefer otherwise, and coordinate publication timing with you.

## Scope

In scope:

- The agent runtime in this repository (`src/`): tool loop, permission manager,
  shell/filesystem/git tools, sub-agents and Mercury Bots.
- Channels shipped here: CLI/TUI, local web dashboard, Telegram, Discord, Slack, Signal.
- The web dashboard and its HTTP/SSE API.
- Skills: `install_skill`, registry fetches and how installed skills are loaded.
- Mercury Cloud client code that lives in this repository.

Out of scope:

- Third-party model providers and their APIs (report to the provider).
- The content and behaviour of skills you install yourself.
- Attacks that require an already-compromised host account or the Mercury
  config directory (`~/.mercury`), or a dashboard deliberately exposed beyond
  `127.0.0.1` without a reverse proxy and authentication.
- A model being persuaded to *ask* for something that you then approve.

## A note on the permission model

Mercury's "Ask Me" mode is the real security boundary: risky commands and
out-of-scope file access prompt you before they run. Shell commands take one of
two lanes (ADR-016 in `DECISIONS.md`):

- **Argv lane (no prompt).** A command is auto-approved only if it tokenises
  into a plain argument list with no shell syntax at all (no `$`, backticks,
  `~`, redirection, pipes, `;`/`&&`, unquoted globs, subshells); its program is
  on a short read-only allowlist (`ls`, `cat`, `head`, `tail`, `wc`, `grep`,
  `rg`, `find`, `tree`, `du`, `df`, `ps`, `uname`, `pwd`, `which`, `echo`,
  `git status|diff|log|branch`, and `cd`, handled in-process); its flags pass
  that program's policy (write/exec flags such as `find -exec`, `rg --pre`,
  `git --output` are refused); and every path argument stays inside the
  working directory or an approved scope. It then runs with
  `execFile(absolute binary, argv)` and a minimal environment, never a shell.
  Binaries are resolved once at startup from a fixed list of system
  directories (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin`,
  `/opt/homebrew/bin`; System32 and Git on Windows), not from `PATH`. Git
  reads run with repository-configured hooks, pagers, external diffs and
  textconv filters disabled.
- **Approval lane (prompt).** Everything else, including pipelines such as
  `git log | head` and `&&` chains of read-only commands. You see the exact
  string; once approved it runs through the platform shell (`sh -c` /
  `cmd.exe`) with the daemon's environment. If an approved command can be
  expressed as argv it still runs without a shell. Allow All, an "always"
  answer, skill elevation and bot allow-lists approve through this lane
  without a prompt; hard-blocked commands are refused in every lane.

What this does and does not cover. The argv lane removes the shell from the
auto-approved path, so the bypass class that kept recurring (redirection,
expansion, chained commands, PATH substitution) no longer applies to it; what
remains is the per-program flag policy, which is a deny/allow table we maintain
and could still miss an option of an allowlisted tool. Path checks are lexical
plus symlink canonicalisation for file tools; the argv lane checks path
arguments lexically. Commands you approve run with whatever the shell does,
by design.

Each agent has its own frozen permission context (channel, sender role, Allow
All, allowed tools, session scopes). Delegated sub-agents get a context derived
from their parent's when they are spawned and can never hold more than the
parent: tool lists are intersected, scopes must be covered by the parent's, skill
elevation is not inherited, and the allow-all of a scheduled/internal turn is
neither inherited nor visible to sub-agents running at the same time.

Service files (`mercury service install`) write a fixed `PATH` rather than the
installing shell's. Keep Ask Me on for any instance reachable by people you do
not fully trust.

Known-fixed issues and the regression tests that cover them are listed in
`docs/security/`.
