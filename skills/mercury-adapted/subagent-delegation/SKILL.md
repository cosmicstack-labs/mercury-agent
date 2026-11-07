---
name: mercury-subagent-delegation
description: Execute an approved plan with one fresh worker per task, spec review before quality review, and no shared mutable scope.
category: development
id: development/subagent-delegation
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the Hermes subagent-driven-development workflow, itself adapted from obra/superpowers (MIT).
license: MIT
intents: [execute this plan with subagents, delegate these tasks, parallel implementation with reviews, orchestrate workers on a plan]
tags: [delegation, subagents, orchestration, review]
allowed-tools: [read_file, list_dir, create_file, write_file, run_command, delegate_task, list_agents, stop_agent, update_plan, ask_user, use_skill]
---

# Mercury Subagent Delegation

Curated independent workflow, not a verified self-made procedure. Delegation buys fresh context and parallelism; it also multiplies cost and can quietly produce confident work nobody checked. Use it when the plan genuinely has independent tasks.

## Approval boundaries

Reading the plan, reviewing worker output and running tests need no separate approval. Dispatching write-capable workers, creating branches or worktrees, committing, pushing, and installing dependencies each need approval for that exact scope. Approval to implement a plan is not approval to push it or to open a pull request.

## Preconditions

- An approved plan exists, or the user explicitly asked for this execution style. For producing the plan itself use `mercury-writing-plans`.
- The tasks can be described completely in a self-contained brief. If a worker would need to read a long design document to start, the plan is not decomposed enough.
- The work is separable: no two tasks editing the same file, and no task whose input depends on another running at the same time.
- The repository is clean enough that each worker's changes are attributable, and the user agreed where work lands. Isolating branches or worktrees is its own approved step — see `mercury-using-git-worktrees`.

## 1. Parse the plan once, in the parent

Read the plan in this conversation and extract every task with its full text, the files it touches, its acceptance check and its ordering constraints. Put that list in a visible plan so the user can see scope. Workers must never be asked to go read the plan file: that recreates the ambiguity delegation was meant to remove.

Write each brief with: the absolute working path, the exact files to create or change, the behavior required, the acceptance command with its expected result, the conventions to follow (read the repository's own `AGENTS.md` guidance and linter config rather than imposing generic style), and what must not be touched. If an exact commit, revision or artifact digest is part of the task, give it verbatim and require the worker to resolve and confirm it before editing — never let a worker reconstruct an identifier from a shortened form.

## 2. Sequence by dependency, then parallelize

Group tasks into a dependency-ordered series of batches. Within a batch, dispatch independent workers concurrently; across batches, do not. Never start a worker whose input is another worker's unmerged output. A safe default is one editing worker per file set, plus read-only reviewers, and no more than the platform's concurrency limit.

## 3. Two-stage review per task: spec first, then quality

After a worker reports, review against the original brief before judging style:

- **Spec review:** every required behavior present, file paths as specified, nothing extra added, acceptance command run and its real output available. A worker's summary is a claim; the parent verifies the artifacts it can read.
- **Quality review:** correctness, error handling, tests, and consistency with the surrounding code. Dispatch this only over the verified spec scope, so a quality label cannot conceal a missing requirement. Use `mercury-spec-compliance-review` for a fresh independent pass when the work is consequential.

If the spec review finds a gap, fix or re-delegate and re-run the spec review. Never advance a task on an unresolved spec failure because the quality review passed.

## 4. Reconcile state before resuming

On resumption, compare the preserved task list with reality: worktree status, commits actually present, and any coordination record. A surviving checklist is not evidence that work is still missing, and a worker's "done" is not evidence that it landed. Replace stale task descriptions with verified obligations before dispatching anything.

## 5. Verify at the batch boundary

Run the repository's own tests, type check and lint at each batch boundary rather than only at the end, so a broken batch is attributable to a small set of changes. Capture exit codes. Then update `mercury-verification-before-completion` before reporting the batch as complete, and report per-task status rather than an aggregate impression.

## Pitfalls

- Two workers editing one file silently lose each other's work; enforce disjoint file sets.
- A worker with an unusable tool inherits the parent's assumptions; tell each worker to report missing capability instead of inventing a result, and check the artifacts yourself.
- Fanning out read-only reviewers is cheap; fanning out writers who each need a full test run is not. Budget before dispatch.
- Workers cannot ask the user questions. Put every decision in the brief, and resolve ambiguity yourself instead of letting a worker guess.
- Do not let reviewers expand scope: a review finding is evidence, not authorization to implement something new. Use `mercury-receiving-code-review` when feedback arrives.
- If delegation is unavailable or the budget is exhausted, do the work inline and say plainly that it was a single pass, not a fan-out.
- Never store task state, worker reports or preferences in files as memory; durable decisions belong in the Second Brain, project state belongs in the repository's own tracking.
