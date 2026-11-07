---
name: mercury-transactional-workflow-recovery
description: Design and test fail-closed recovery of journaled workflows without repeating committed side effects.
category: development
id: development/transactional-workflow-recovery
version: 0.1.0
license: MIT
author: 'Cosmic Stack; adapted from Hermes Curator and Hermes Agent'
intents: [repair-crash-recovery, verify-idempotent-replay]
tags: [transactions, recovery, testing]
allowed-tools: [read_file, list_dir, run_command, ask_user, use_skill]
---

# Transactional Workflow Recovery

Curated instructions, not an installed recovery engine. Use for a crash between durable commit and durable decision recording. Inspect the actual protocol before proposing a repair; obtain approval for exact source changes and separately for any production recovery operation. Never replay real transactions merely to test this workflow.

## Establish the invariant

Read the public entrypoint, journal writer, decision store and relevant tests with `read_file` and bounded `run_command` searches. Identify the protocol version, candidate identity, canonical target, terminal states, durable-write ordering and trust boundary. Existing decisions must be validated against their identity and returned unchanged, not silently overwritten.

A missing decision can be reconstructed only when all required evidence agrees: exact input bytes and recorded hash; expected schema and terminal state; canonical target; journal integrity; committed artifact bytes and hash; and immutable decision-store semantics. A digest proves integrity relative to its trusted record, not authorization. A self-seal or a key readable by the attacking principal is not independent authority.

Missing, malformed, contradictory or byte-mismatched evidence must fail closed. Do not infer success from names, timestamps or semantically equivalent text. A missing journal alone is not proof that normal processing is safe: reconcile the decision and any authority sidecar stores in both directions first. Unexplained orphans block normal processing.

## Implement a scoped repair

1. Use `mercury-test-driven-development` to reproduce the crash window in isolated fixtures before changes. Freeze the intended acceptance contract and distinguish a bug repair from a protocol migration.
2. Bind candidate identity and inspect existing durable state before fetch, draft, verify, write, index, notify or external-command collaborators. Valid replay reconstructs only the missing immutable decision, then returns immediately.
3. Invalid evidence returns the protocol's explicit review/error outcome without attempting a best-effort repair. Quarantine or terminal-resolution writes require an explicit protocol contract and tests; do not invent them during recovery.
4. Normal processing is allowed only when the contract proves there is no prior transaction or unresolved authority. Preserve concurrent writers through existing atomic/create-if-absent or compare-and-set semantics. Conflicting existing decisions are errors, not overwrite opportunities.
5. If hostile path replacement is in scope, inspect descriptor-bound operations and workspace identity across validation and use. Resolving a path once does not eliminate time-of-check/time-of-use races. Do not redesign authority storage or migrate journals without separate approval.

## Verify

Use temporary fixtures and sentinels that fail if replay invokes a forbidden collaborator. Cover valid replay, second replay, normal new work, missing/tampered artifacts, wrong input/hash/path/state/schema/seal, malformed journals, conflicting decisions and both directions of orphaned authority. Test through the public workflow, not only parser helpers. Inject a crash after each relevant durable write. When authority continuity is claimed, separately delete/replace its components and the workspace at the same lexical path; a writable marker is not external authority.

Run focused regressions, the relevant suite, type checks and diff checks. Use `mercury-verification-before-completion` to bind results to the final bytes. Report simulated crash coverage, actual commands and missing environments; unit fixtures do not prove power-loss or production filesystem durability.

Keep journals limited to authorized application transaction data. User preferences and cross-session knowledge belong only in the Second Brain. No upstream scripts or reference files are bundled, and this workflow grants no permission to send, publish, delete, migrate or access secrets.
