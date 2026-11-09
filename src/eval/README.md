# Agent replay evaluations

Run `npm run eval -- --maxWorkers=2`. No provider credentials or network calls
are needed. Each fixture gets a scratch Mercury home and working directory.

The harness runs the production `Agent`, AI SDK tool loop, permissions, work
ledger, session repository, and memory stores. The provider replays scripted
steps and the channel records delivery. A tool call with a `result` uses a
recorded output; omit `result` to execute the actual capability in the scratch
directory. Check `toolCalls[].recorded` when a scenario relies on real effects.

`scenarios/reliability.test.ts` exercises both streaming and non-streaming
delivery with real filesystem tools:

| Scenario | Evidence checked |
| --- | --- |
| Write denied twice, then explicitly approved | Original bytes survive both denials; real approval prompts recur; denial reaches the next model call and stored tool trace; a fresh approval permits the write. |
| Completed inbound message redelivered | No new provider/tool call or session entry; later owner edits survive; ledger still has one attempt. |
| Provider fails after a write | Exactly one write; backup provider is never called; progress is reported as pending, with a durable continuation rather than a completed answer. |
| Duplicate while running, then owner stops | Duplicate is not queued; the real abort signal releases the pending provider; completed file survives; reloaded work remains cancelled and is not recovered or reexecuted on redelivery. |

Fixtures can opt out of auto-approval with `autoApprove: false`. Tests install
an explicit `permissions.onAsk` response so the actual permission manager
decides whether a write runs. `ScenarioTurn.messageId` can be reused to model
transport redelivery. Provider `failOnCalls` and `waitForAbortOnCalls` use
one-based call numbers across the provider's lifetime, including failed calls;
neither consumes a scripted output step. Abort waits must be released through
the real agent stop path, including test cleanup.

These are deterministic integration regressions, not measurements of a live
model's honesty or tool-selection quality. The denial case checks the evidence
and delivery pipeline; its final model wording is scripted. Fake timers keep
heartbeats and retry timers from firing during a turn. In particular, the
post-write provider failure test verifies suppression of immediate fallback
and preservation of the existing *ordinary chat* continuation policy; it does
not establish exactly-once execution across later retries, external services,
or process crashes. Scheduled-task recovery belongs in scheduler integration
tests, which can exercise its durable state without a live model.
