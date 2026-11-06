---
name: mercury-simplify-changes
description: Clean up recent code changes with four parallel reviewers (reuse, quality, efficiency, altitude), then apply only verified fixes.
category: software-development
id: software-development/simplify-changes
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the installed Hermes simplify-code workflow (itself inspired by Claude Code /simplify); no upstream text or scripts bundled.
license: MIT
intents: [simplify my changes, clean up my recent code, review my diff for quality, reduce duplication in what I just wrote]
tags: [cleanup, refactor, code-review, delegation]
---

# Mercury Simplify Changes

Curated independent workflow, not a verified self-made procedure. This is a cleanup pass on code that already works, not a bug hunt — for a pre-commit correctness and security gate use `mercury-requesting-code-review` instead.

Four narrow reviewers beat one broad one: each searches the whole codebase for a single class of problem without diluting attention, and they run concurrently so you pay one review's latency.

Only run this when asked. It costs four subagents' worth of tokens, so never tack it onto unrelated work or run it after every edit.

## Approval boundaries

Reading the diff, searching the codebase and reporting findings needs no separate approval. Applying edits to source code does: present the exact proposed changes per file and wait for confirmation. If the user said "just report" or "don't change anything", apply nothing and ask. Deleting code, changing a public API, or touching shared infrastructure always needs its own explicit approval.

## Phase 1 — Capture the diff

Pick the source from what the user asked, in this order: `git diff` for working-tree changes, then `git diff HEAD` to include staged, then the scoped variants `git diff --staged`, `git diff HEAD~1`, `git diff main...HEAD`, or `git diff -- <paths>`.

If both diffs are empty and there is no repository, fall back to the files the user named or that were edited in this session; if there is genuinely nothing, say so and stop. Read the full diff text and measure it: past roughly 2000 changed lines, warn that four reviewers each carrying the whole diff is token-heavy and offer to scope it per directory or per commit first.

## Phase 2 — Fan out four reviewers

Dispatch all four through `delegate_task` in one batch so they run concurrently — four is the useful width, within any default concurrency budget. Give every reviewer the complete diff (cross-file problems hide in fragments), the absolute repository path, and read access so it can search the wider codebase. Tell each one to:

- Search the codebase for evidence rather than reasoning from the diff alone.
- Apply Chesterton's fence: before proposing a removal, run `git blame` on the line. If the original purpose is unclear, mark confidence low instead of guessing.
- Report each finding as `file:line → problem → cost → suggested fix | confidence | risk`, where cost names what is duplicated, wasted or harder to maintain. A finding that cannot state its cost is probably a nit.

Risk tiers: SAFE means provably no behavior change (unused imports, commented-out code, pass-through wrappers). CAREFUL improves without changing semantics (rename a local, flatten a nested ternary, extract a helper) and needs test verification. RISKY may change behavior or a public contract (query reshaping, API rename, lifecycle change) and must never be auto-applied.

If delegation is unavailable — a leaf subagent, delegation disabled, exhausted budget — do not skip angles: work through all four sequentially yourself with the same standards, and state plainly in the summary that this was an inline single pass rather than a fan-out.

**Reviewer 1, reuse.** Find code duplicating something already in the codebase. Search utility modules, shared helpers and adjacent files for existing functions, constants or patterns the new code could call. Flag new functions that duplicate existing ones, and hand-rolled logic an existing utility already covers (manual path or string manipulation, custom environment checks, ad-hoc type guards, re-implemented parsing). Name the existing thing and where it lives.

**Reviewer 2, quality.** Find redundant state that duplicates or could derive from existing state, caches that need not exist, parameter sprawl where a function should have been restructured, copy-paste-with-variation that wants a shared abstraction, leaky abstractions, stringly-typed code where a constant, enum or registry already exists (check the canonical registry before flagging), deeply nested conditionals that flatten with guard clauses or a lookup, and generated-slop patterns: comments restating obvious code, defensive null checks on already-validated input, `as any` casts bypassing types, and patterns inconsistent with the surrounding file.

**Reviewer 3, efficiency.** Find unnecessary work (redundant computation, repeated file reads, duplicate calls, N+1 patterns), missed concurrency between independent operations, heavy or blocking work on startup and per-request paths, check-then-act races where doing the operation and handling the error is correct, unbounded growth or missing cleanup, listener and handle leaks, closures capturing a whole enclosing scope where a small class or explicit fields would copy only what is needed, reads broader than necessary, and silent failures (empty catch, ignored error return, `.catch(() => {})`, `except: pass`) that hide bugs and should at minimum log.

**Reviewer 4, altitude.** Find changes made at the wrong depth: a special case bolted into a generic path for one caller, a symptom patched at one call site while siblings keep the flaw, a workaround stacked on an earlier workaround, a wrapper added to avoid touching the real mechanism, or a flag introduced to route around a broken default. For each, name the underlying mechanism being dodged and the deeper fix — generalize the shared path, fix the root default, or fix the bug class — and say honestly when the deeper fix is large enough to be its own task. Read the surrounding code and `git blame` first: compatibility shims, staged migrations and vendored-code isolation look like band-aids but are deliberate boundaries, so do not flag them.

## Phase 3 — Aggregate and apply

1. Merge findings into one list, collapsing overlaps that target the same line or mechanism.
2. Discard false positives silently. You hold the most context; you do not owe a reviewer an argument.
3. Resolve conflicts in this order: correctness, then the user's stated focus, then readability and reuse, then micro-performance. Do not apply a performance change that hurts clarity unless the path is genuinely hot. When two defensible suggestions are mutually exclusive, take the one touching less code and note the alternative.
4. Apply in risk order. SAFE first, then the tests. CAREFUL next, one file at a time with tests after each file, reverting any that break. RISKY last and only as a proposal with the risk and current test coverage stated — altitude findings usually land here.
5. Verify: run the targeted tests for touched files rather than the whole suite, plus the repository's own lint and type check. If a fix breaks a test, revert that fix alone and report it.
6. Summarize applied fixes grouped by reviewer category and risk tier, plus the findings deliberately skipped and why. Say explicitly whether the review ran as a fan-out or inline.

## Pitfalls

- Do not fan out wider than four. More reviewers means more cost and more conflicting suggestions, not better coverage.
- Never split the diff across reviewers; cross-file duplication and N+1s only appear with the full picture.
- A reuse finding without a `file:line` pointer to the existing utility is noise. Require evidence and drop the rest.
- Cleanup is not a license to refactor the module. Keep edits inside the diff plus the minimal surrounding change a fix requires; flag anything deeper instead of rebuilding shared machinery mid-cleanup.
- A genuine correctness bug found here is reported separately and prominently, never folded into cleanup fixes.
- Respect house conventions: read any `AGENTS.md`, `CLAUDE.md` or linter config and fold those rules into the reviewer briefs.
- Dead-code tools report exports used dynamically through string imports or reflection. Grep the symbol before removing anything.
- Export names, route paths, database columns and config keys are contracts. Tag renames RISKY and never auto-rename.
- An empty catch or ignored error may be intentional for an expected benign case. Flag it, do not remove it.
- Not every special case is a band-aid; compatibility shims and staged migrations are deliberate. Check blame and comments, and mark unclear intent as low confidence.

## Completion check

Report the diff source and size, the applied fixes by tier, the skipped findings with reasons, the targeted checks that ran with their results, and whether the review was parallel or inline. Then update `mercury-verification-before-completion` before claiming the cleanup is done.
