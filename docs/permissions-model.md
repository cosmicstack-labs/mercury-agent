# Mercury permission model

This document reflects the live permission wiring in the local repo, not the older scheduler/security notes.

## Summary

- Mercury keeps permission state per session/channel.
- `Ask Me` and `Allow All` are session modes, not global switches.
- `Allow All` enables auto-approval for the current session/channel only.
- `Allow All` does **not** add root filesystem scope.
- Internal flows and scheduled tasks also use auto-approval, but under that same restricted model.

## Session and channel isolation

Permission state lives inside `PermissionManager` session state keyed by channel. That state includes:

- `autoApproveAll`
- pending approvals
- temporary scopes
- channel type metadata

Practical consequence: enabling `Allow All` in one Telegram chat or one CLI session does not silently affect another channel.

Relevant files:

- `src/capabilities/permissions.ts`
- `src/capabilities/permissions.test.ts`

## Interactive modes

Interactive channels expose two modes:

- **Ask Me** — Mercury asks before risky shell commands, file writes, and permission escalations.
- **Allow All** — Mercury auto-approves those interactive prompts inside the current session/channel.

The current wiring is in `src/core/permission-mode.ts`:

```ts
permissions.setCurrentChannel(channelId, channelType);
permissions.setAutoApproveAll(mode === 'allow-all');
```

That function does **not** add `addTempScope('/')` or any equivalent root filesystem grant.

Relevant files:

- `src/core/permission-mode.ts`
- `src/core/permission-mode.test.ts`
- `src/index.ts`

## System messages: internal and scheduled

Mercury uses one permission model for user sessions and system-triggered runs.

`getMessagePermissionPolicy(...)` currently returns only:

- `autoApproveAll: true`

for:

- internal messages (`channelType === 'internal'`)
- scheduled/system messages (`senderId === 'system'` outside the internal channel)

This means scheduled runs are auto-approved, but they do not get a different unrestricted filesystem mode.

Relevant files:

- `src/core/agent.ts`
- `src/core/agent-permissions.test.ts`

## Scheduled task context

Scheduled tasks are not strictly “non-channel” anymore. When a task is created from a live channel, Mercury persists the origin context and replays the job as a system message tied to that source channel.

That preserves:

- correct delivery context
- session/channel isolation
- the same restricted auto-approval model

Relevant files:

- `src/capabilities/scheduler/schedule-task.ts`
- `src/capabilities/registry.ts`
- `src/core/agent.ts`

## What skill allowed-tools do

Skills can declare `allowed-tools` in `SKILL.md` to unlock specific tools while the skill is active.

Important boundary:

- `allowed-tools` do **not** bypass filesystem scopes
- `allowed-tools` do **not** bypass blocked shell commands
- filesystem access still requires an approved permanent or temporary scope

So the correct model is:

> Skills can unlock tool usage, but Mercury still enforces path boundaries and shell safety rules.

## What Allow All does not do

`Allow All` should not be documented as unrestricted filesystem access.

What still applies:

- shell blocklist
- filesystem scoping
- per-session/channel isolation

So the correct mental model is:

> `Allow All` removes confirmation prompts inside the current session. It does not remove Mercury's filesystem boundaries.

## Local patch consolidation status

The local repo now reflects a fully consolidated permission hardening pass with three practical outcomes:

1. `Allow All` is wired through `applySessionPermissionMode(...)` without root temp scope.
2. Internal and scheduled runs stay auto-approved without `addTempScope('/')`.
3. The message permission contract now models only the active behavior (`autoApproveAll`), with session state isolation covered by dedicated tests.

## Evidence and reproducibility

Useful verification points in this repo:

- `src/core/permission-mode.test.ts`
- `src/core/agent-permissions.test.ts`
- `src/capabilities/permissions.test.ts`
- `src/channels/telegram.test.ts`

For sandbox validation, use:

- `docs/mercury-sandbox-smoke.md`
- `scripts/run_mercury_sandbox_smoke.sh`

The smoke test validates the sandbox startup path with `glm-5.1`, manual `.env` loading, workspace `cwd`, interactive permission selection, and a minimal `OK` roundtrip.