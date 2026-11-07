---
name: mercury-repository-implementation-analysis
description: Find the nearest working implementation template in a repository before planning a feature, and label honestly when no precedent exists.
category: software-development
id: software-development/repository-implementation-analysis
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the installed Hermes repository-implementation-analysis workflow; no upstream text or scripts bundled.
license: MIT
intents: [find a golden template, analyze how a feature is implemented, plan a change to an unfamiliar codebase, check for existing precedent before building]
tags: [codebase-analysis, planning, architecture, precedent]
---

# Mercury Repository Implementation Analysis

Curated independent workflow, not a verified self-made procedure. Analysis only: this skill never authorizes edits. Read-only inspection needs no approval; every source or configuration change still requires an exact proposed diff and confirmation first.

## When to use

- The user asks for a template, precedent, pattern or implementation-shape analysis.
- An upcoming feature spans configuration, runtime state, UI, persistence or tests.
- The codebase is unfamiliar and the plan should follow native conventions.
- Policy may be duplicated across layers and needs an authority comparison.

Not a generic repository summary. Analyze only the named concerns plus the wiring needed to understand them. For a full onboarding sweep use `mercury-read-only-audit-brief` instead.

## Path

Runtime ownership map, then concern-specific searches, then producer-to-consumer traces, then authority-versus-presentation comparison, then classification, then findings with honest gaps. Run independent concern searches in parallel through `run_command` (ripgrep) and serialize only when one symbol must be located before its consumer can be traced.

## Procedure

1. Map the repository shape in one compact paragraph: entry point, state owner, controller or UI layer, integration boundaries, and the test or inspection surface. Read the manifest scripts rather than restating them from memory.
2. Search by concern, using domain terms and structural equivalents: config (enum, constants, defaults, merge, lookup), mutation (handler, dispatch, command, state method), eligibility (can, validate, disabled, reason, guard, policy), rendering metadata (mount, emitter, transform, reference), and behavior tests (smoke, fixture, assertion, deterministic probe). Read enough surrounding code to establish ownership and call direction; a declaration alone is not a template.
3. Trace one complete edge per candidate: declaration to initialization to runtime consumption; affordance to authoritative mutation to feedback; predicate to mutation guard to user-visible reason; test driver to public surface to observed assertion.
4. Classify evidence strength explicitly: declared (the symbol exists), wired (another component reads it), behavioral (it changes runtime state or rendered output), verified (a test or deterministic probe observes it). Never promote declared or wired code to a behavioral template.
5. Compare authority against presentation. Check whether UI, API and runtime each recompute the same rule, and pay special attention to queued, pending, cached or asynchronous state. Report divergence even when the happy path looks correct on both sides.
6. State the least-novel extension when no precedent exists: say so directly, name the nearest stable extension point, list external contracts that must stay unchanged, and identify timing or lifecycle hazards the design must resolve. Do not manufacture a template from dead code, comments, decorative metadata or unused fields.
7. Report concern by concern with exact path, symbol and line range; the semantics to preserve (ownership, call direction, defaults, return contract, mutation timing, verification style); and a warning where relevant (no precedent, duplicated logic, write-only state, wiring mismatch). End with the strongest reusable templates and the genuine gaps.
8. Close with a verification checklist: entry point and state owner identified, exact symbols and locations for every finding, producer and consumer both read, UI policy compared with authoritative guards, metadata traced to real runtime use, native test surface identified, missing precedents labeled, and no files modified.

## Pitfalls

- Proximity is not precedent. Nearby code is only a template when its semantics match.
- An unreferenced requirements table is evidence of intent, not enforcement.
- Stored references matter only when runtime aiming, effect placement or another consumer actually reads them.
- UI checks may omit a pending or queued state that the runtime enforces.
- Pausing one update method may not pause wall-clock timers, subsystem clocks or animation loops.
- Centralizing logic must not break established public APIs; add richer query methods when the UI needs reasons.
- Prefer the repository-native test harness over a foreign one.
- Report implementation templates, not a general code review.

## Completion check

Deliver paths, symbols and evidence classification per concern, and state plainly where no honest precedent exists. Confirm no source file was modified. Findings feed a plan in `mercury-writing-plans`, and any resulting edit still needs exact approval first.
