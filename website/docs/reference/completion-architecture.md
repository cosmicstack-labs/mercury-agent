---
title: The Completion Architecture
description: "How Mercury Code guarantees honest, verified, stall-free task completions — the completion contract, the escalation harness, and the recovery map."
keywords: [mercury, mercury-code, completion contract, escalation harness, stall watchdog, recovery]
---

# The Completion Architecture

> How Mercury Code guarantees **honest, verified, stall-free** task endings — every failure mode routed to a named recovery path instead of a death, and no task claiming success without evidence.

Introduced in **v1.2.3 — Unstoppable Mercury**. This page documents the architecture of the completion pipeline: the problem it solves, the components, and where each lives in the code.

## The problem it solves

Before the contract, the agent loop was a single optimistic pass: the model generated, tools ran, and **any** ending was celebrated as "Task complete" — including step-budget exhaustion over half-done work, writes severed mid-argument by an output cap, and provider drops that silently cut responses. A narration-prone model could describe work forever without producing a file, and long builds died at memory pressure.

The architecture now routes **every** failure mode to recovery:

```text
                          USER MESSAGE
                               │
                        LLM GENERATION
          (step-aware streaming · no imposed output cap
           · per-step memory governor checkpoints)
                               │
                        TOOL EXECUTION
          (forced-action capable: toolChoice 'required'
           + mutating-tools-only on guard steps)
                               │
              ┌────── TURN-END VERDICT ───────┐
              │ classifyTurnEnd: WHY did it end? │
              └──┬────────┬─────────┬────────┘
        text-stop│  steps-│exhausted│ interrupted/truncated  aborted
                 ▼        ▼         ▼
       VERIFICATION   AUTO-CONTINUE   SECTIONED-WRITE
       GATE (build/   (fresh budget   guidance + FULL-
       test required) ×6 automatic)   budget resume
                 │        │         │
                 ▼        ▼         ▼
       ┌──── NARRATION GUARD (if no work landed) ────┐
       │ 1. GROUNDING — agent runs readdir itself    │
       │ 2. FORCED STEP — mutating tools only +      │
       │    toolChoice 'required'                    │
       │ 3. PROVIDER ROTATION — next model per round │
       │ 4. WAKE-UP CALL — doubled bound, blunt      │
       │    directive (10 mechanical rounds total)   │
       └──────────────────┬─────────────────────────┘
                          ▼
       ┌──── RECOVERY LAYER ────────────────────────┐
       │ memory pressure → COMPACT in place,        │
       │                    CONTINUE                │
       │ doom loops → abort attempt → next provider │
       │ stall 3 min → pulse · 8 min → resume       │
       │ provider errors → fallback + named ledger  │
       └──────────────────┬─────────────────────────┘
                             ▼
                      FINAL VERDICT
        ┌─────────────┬──────────┴────────┐
   verified completion   honest pause    "no changes" honesty
   + change summary      (names blocker, banner (git-verified
   + file previews       resumable, persisted) only)
```

## The verdict system

`src/core/completion-verdict.ts` answers one question at every turn boundary: **why did the loop end, and is that a legitimate completion?**

| Verdict | Meaning | What happens |
|---|---|---|
| `text-stop` | The model chose to stop with a final answer | Verification gate (execute/AUTO) → evidence-gated completion |
| `steps-exhausted` | Step budget ran out with tool calls pending | **Pause** — bounded auto-continuation (6 fresh budgets), then an honest, resumable pause |
| `interrupted` | Provider dropped mid-generation (no finish signal) | Retry/fallback machinery |
| `truncated` | Output hit the limit mid-response | Sectioned-write guidance + full-budget resume rounds |
| `aborted` | User halt / safety control | Explicit failed state, artifacts preserved |

## The narration guard — the escalation harness

When a model narrates ("Building X…") without doing work, the guard escalates mechanically. None of it depends on the model's goodwill:

1. **Grounding** — the agent executes a deterministic directory listing itself (no LLM) and injects it as verified state. The model cannot claim it lacks context.
2. **Forced action** — via `prepareStep`, the first step of a guard round runs with `toolChoice: 'required'` and **mutating tools only** (`create_file`, `write_file`, `edit_file`, `run_command`, …). Narration is mechanically impossible on that step.
3. **Provider rotation** — guard rounds walk the fallback chain. A narration-locked model is not the only worker the agent has.
4. **Wake-up call** — after a full failed cycle, the bound doubles (10 mechanical rounds total) with a blunt directive: *"Your next response MUST begin with a mutating tool call. ZERO prose."* Only after both cycles → an honest pause naming the blocker.

## Compact-on-pressure

Adopted from OpenCode's session pipeline: memory pressure **compacts the conversation in place and continues** instead of aborting. Messages beyond the newest 8 have oversized tool results and long text replaced with head+tail summaries (`compactConversation` in `src/core/memory-governor.ts`). A second consecutive pressure verdict aborts. Long builds stop dying at memory limits.

## Honest endings

- **Evidence-gated completion** — implementation tasks must run a build/test/typecheck command before the "Task complete" banner is allowed (`src/core/execute-guard.ts`).
- **Named blockers** — every pause carries the last failed mutating-tool result (e.g. `write_file: permission denied`), so the fix is visible in the chat.
- **Resumable pauses** — the work ledger records `paused` status: recovered on restart, resumable by sending "continue" (`src/core/work-ledger.ts`).
- **Honest banners** — `Response delivered · no file changes` (git-verified), first-person pause messages, and a change summary with per-file +/− stats and verification evidence (`✓ Verified: npm test ✓`).

## Stream integrity

`src/core/stream-completion.ts` classifies provider stream endings: a missing or `other` finish reason is an **interruption** (never treated as success), `length` is a **truncation** — and if the truncation severed a file write, the resume nudge demands sectioned writes: `create_file` the first ~80 lines, then `edit_file` appends, with full-budget resume rounds.

## The watchdog

`src/core/stall-watchdog.ts` covers TIME the way the memory governor covers heap:

| Threshold | Default | Action |
|---|---|---|
| Soft | 3 min | Visible "still working · Ns silent" pulse |
| Hard | 8 min | Abort the attempt into the resume machinery |

Tunable via `MERCURY_STALL_SOFT_MS` / `MERCURY_STALL_HARD_MS`. Never silently kills a task — escalation surfaces in the UI.

## Output limits — none of Mercury's own

Mercury imposes **no output size limit**: the ceiling is 32,768 tokens, deliberately above every mainstream model's native limit, so the model's own limit governs. Providers that reject a high `max_tokens` get an adaptive halving and the chain continues. Sectioned-write guidance remains for models with genuinely small native limits.

## AUTO mode

Mercury Code's default flow: read first, plan silently, implement immediately. Small/medium changes build without asking; large or consequential changes present a concise plan with a single `ask_user` confirmation (recommended option default-selected), then build without re-asking. See the [v1.2.3 release notes](/docs/releases/1.2.3) for the AUTO-mode flow.

## Testing invariants

The pipeline is pinned by regression tests (`completion-contract.test.ts`, `completion-verdict.test.ts`, `stall-watchdog.test.ts`, and friends):

- Pause paths precede completion delivery in the code — budget exhaustion can never produce a completion banner.
- Sub-agents report `paused`, not `completed`, on budget exhaustion; the supervisor auto-resumes.
- Every honest banner exists and is guarded in source.

For the full before/after walkthrough, see the [v1.2.3 release notes](/docs/releases/1.2.3).