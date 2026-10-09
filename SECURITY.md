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
out-of-scope file access prompt you before they run. On top of that, a small
allowlist of read-only commands (`ls`, `cat`, `grep`, `find`, ...) is auto-approved
for usability. That classifier is a **best-effort** pattern check on the command
string. Several bypasses of it have been reported and fixed (find action flags,
shell redirection, variable expansion), and we expect the class to keep producing
reports until the auto-approval lane is rebuilt around a tokenised argv allowlist
with per-command flag policy (tracked in `ROADMAP.md`, P2.2). Until then, treat
auto-approval as a convenience, not a guarantee, and keep Ask Me on for any
instance reachable by people you do not fully trust.

Known-fixed issues and the regression tests that cover them are listed in
`docs/security/`.
