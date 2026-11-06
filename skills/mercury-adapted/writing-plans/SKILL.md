---
name: mercury-writing-plans
description: Produce scoped implementation plans with exact paths, approval gates, and acceptance checks.
category: development
id: development/writing-plans
version: 0.1.0
author: Mercury
attribution: Adapted from Hermes Agent writing-plans 1.1.1, derived from obra/superpowers.
license: MIT
tags: [planning, implementation, design, workflow]
intents: [plan changes, break down implementation, prepare handoff]
allowed-tools: [read_file, list_dir, run_command, create_file]
---

# Mercury Writing Plans

Curated adaptation of the upstream skill, not a self-made verified procedure.
Use for multi-step changes, meaningful tradeoffs, or implementation handoffs.
For trivial work, a compact checklist is enough; do not add ceremony without value.

## Planning is not execution approval

- Explore read-only first; get explicit approval before source/config edits.
- Present exact proposed scope and wait for approval before implementing it.
- Existing implementation approval applies only to its stated scope.
- Identify consequential actions separately: dependencies, network operations,
  migration, deployment, service restart, deletion, commits, and pushes.
- Obtain exact approval for those actions; never automatically commit or push.
- Preserve unrelated owner changes; never destructively revert or stash dirty work.
- Do not turn an upstream user's preferences into this user's requirements.
- Store user facts, goals, and preferences only through available Second Brain
  tools. Never create diary, memory, or personal-notes files.

A technical plan may be an explicitly requested project deliverable, not a user
memory store. Default to presenting it in chat. Create a plan file only when that
artifact and path are explicitly approved; keep personal knowledge out of it.

## 1. Discover constraints

1. Read the request and translate it into observable acceptance criteria.
2. Inspect repository instructions, relevant files, scripts, tests, and conventions.
3. Check `git status --short` and scoped diffs to identify owner work to preserve.
4. Separate confirmed facts, assumptions, open questions, and out-of-scope work.
5. Identify environment limits and existing test tooling without installing anything.

Use `list_dir` and `read_file`. Search with `grep` via `run_command`, for example:

```text
run_command(command="grep -R -n -F 'similar_feature' src")
run_command(command="git status --short")
```

Use exact discovered paths in the final plan; mark illustrative examples as such.
External documentation is optional and requires available, approved tooling.
If available in another context, use native `fetch_url`, not `web_extract`;
neither is included in this skill's current allowed tools.

## 2. Select an approach

- Explain the smallest design that satisfies the actual requirements.
- Reuse local patterns where appropriate; avoid speculative abstractions.
- List meaningful tradeoffs, risks, compatibility constraints, and alternatives.
- Ask the user to choose when a branch materially changes scope or consequences.
- Recommend an option, but do not interpret silence as approval.
- Use defensible low-risk defaults for minor details and state them concisely.

Do not assume unavailable analysis skills, clarification tools, or upstream
user-specific workflows are installed or required.

## 3. Break work into independently checkable tasks

Prefer small behavior slices, each with an observable result and clear dependency.
A two-to-five-minute task is a useful heuristic, not a promise or rigid limit.
Include enough implementation detail to avoid guessing; do not invent line numbers,
interfaces, commands, or expected test counts that inspection has not established.

### Suggested plan header

```markdown
# [Change] Implementation Plan
Goal: [Observable outcome]
Scope: [Included paths and behavior; explicit exclusions]
Approach: [Design and relevant existing technologies]
Approval status: [Proposed / approved scope and outstanding gates]
Acceptance: [Concrete conditions]
```

### Suggested task template

```markdown
## Task N: [One behavior or deliverable]
Objective: [Outcome]
Files: [Exact create/modify/test paths; owner-work constraints]
Prerequisites: [Dependencies on earlier tasks and approval gates]
1. Add a focused test for the required behavior, where appropriate.
2. Run [exact discovered command]; expect [specific behavioral assertion failure].
3. Implement the smallest approved change.
4. Run [targeted command], then [appropriate broader checks].
Acceptance: [Observable result, not just files existing]
Risks / recovery: [Safe response preserving unrelated work]
```

Import or setup errors do not count as behavioral RED. For documentation/config
work, specify proportionate validation instead of forcing irrelevant unit tests.
For existing implementations, label tests-after honestly rather than claiming TDD.
Do not add automatic commit, push, install, or deployment steps to this template.

## 4. Review and hand off

- Confirm every requirement maps to a task and acceptance check.
- Verify paths and commands against the repository; label unresolved assumptions.
- Include error cases and integration checks proportional to risk.
- Ensure approval gates occur before edits and consequential actions.
- Keep recovery scoped to your changes, never owner-tree reset or blanket stash.
- State whether the plan is merely proposed, approved, implemented, or verified.
- Offer execution only within approval; planning completion is not implementation.

If delegation becomes available, use `delegate_task(task=...)`, not `goal`.
Supply bounded scope, acceptance criteria, approvals, and preservation constraints;
review the resulting diff and independently verify consequential claims.
No delegation tool is assumed by the current allowlist.
