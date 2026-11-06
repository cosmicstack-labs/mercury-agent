---
name: mercury-verification-before-completion
description: Bind completion claims to executed checks for the exact artifact and scope.
category: development
id: development/verification-before-completion
version: 0.1.0
author: Mercury
attribution: Adapted from Hermes verification-before-completion 1.0.5, originally obra/superpowers.
license: MIT
tags: [verification, evidence, completion, quality]
intents: [verify results, review completion claims, validate delegated work]
allowed-tools: [read_file, list_dir, run_command, create_file]
---

# Mercury Verification Before Completion

Curated adaptation of the upstream skill, not a self-made verified procedure.
Use before claiming work is complete, fixed, passing, built, or active.
Evidence supports a particular claim under particular conditions, not all claims.

## Safety comes before verification

- Verification is not permission to edit source or configuration: obtain explicit
  approval for those edits and any change in scope.
- Obtain exact approval for consequential checks involving network calls, external
  side effects, dependency installation, service restart, deployment, or deletion.
- Never automatically commit or push after checks pass.
- Inspect workspace state and preserve unrelated owner work.
- Never destructively revert or stash a dirty owner tree to demonstrate RED.
- Do not install missing tooling just to turn a blocked check into a passing one.
- Store user knowledge only through available Second Brain tools, never diary files.

## The evidence gate

Before making a success claim:
1. Identify the specific claim and the check that could establish it.
2. Execute the complete relevant check, or establish that an existing run matches
   the exact current artifact, selection, runner, configuration, and environment.
3. Read the output, exit code, failures, warnings, skips, and exercised scope.
4. Compare the evidence with acceptance criteria, not just the command's exit code.
5. State only what the result supports, with limitations and unrun checks.

A command invocation is not a completed run. A background process launch proves
only launch; wait for bounded completion and inspect final output and exit status.
If a check times out, report timeout and partial evidence rather than success.

## Match the check to the claim

| Claim | Appropriate evidence | Insufficient evidence |
| --- | --- | --- |
| Targeted tests pass | Named tests complete with actual results | Tests merely collected |
| Relevant suite passes | Full selected suite output and exit code | One targeted test |
| Build succeeds | Actual build completes successfully | Linter passes |
| Bug fixed | Original symptom is exercised and now passes | Source changed |
| Regression detects bug | Intended behavioral failure then pass | New test passes once |
| Requirements met | Acceptance checklist checked against artifacts | Tests alone |
| Runtime active | Approved activation and current runtime probe | Local build |
| Delegated work accepted | Reviewed diff and independent relevant checks | Agent summary |

A static check can be valuable without proving behavior. Label it accurately.
A curated skill document is not a verified operational procedure merely because
its metadata and formatting passed validation.

## Construct trustworthy probes

- Read the affected implementation and callers before choosing a probe.
- Assert observable results and preserved state, not incidental source spelling.
- Distinguish setup, compilation, and import failures from behavioral failures.
- Inspect expected-failure wrappers: exit zero may mean a defect reproduced.
- When inspecting mutable mock arguments, snapshot values at call time.
- Exercise boundary and adverse cases that bear on the actual defect.
- For async behavior, consider delayed effects, timeout paths, and ordering.
- For resource bounds, measure the costly operation rather than a nearby proxy.
- Label simulations separately from target-runtime or instrumented execution.
- Report unavailable sanitizer/runtime instrumentation as unavailable, not passing.

Keep probes proportional to risk; do not import every upstream specialty checklist
into unrelated work. Preserve existing assertions while adding relevant cases.

## Evidence freshness and workspace state

An unchanged, artifact-bound completed run may be reused; a conversation turn does
not itself invalidate evidence. Rerun when relevant inputs changed or equivalence
cannot be established. Name reused evidence as such rather than implying a new run.

Use `run_command` for checks and `grep` searches; inspect files with `read_file`.
Check current `git status --short` and scoped diffs before handoff. Volatile state
such as running services, remote state, and current workspace cleanliness needs
current observation; an earlier test receipt cannot establish it.

For historical RED, use an explicitly approved isolated baseline or mutation, not
owner-tree rollback. Name which tests actually failed behaviorally; tests that
passed on the broken baseline are additional coverage, not proven RED cases.

## Negative claims and delegated results

“Nothing was sent” and “no files changed” need evidence too. Identify relevant
sources, inspect those available within approval, and bound the wording:
“No evidence found in [sources checked]” is safer than unsupported global absence.
Do not query unrelated private systems just to satisfy a generic checklist.

Treat delegated reports as claims until their artifacts and key checks are
independently reviewed. A child completion notice does not authorize further work.
If delegation is available separately, its native argument is `task`, not `goal`;
it is not among this skill's allowed tools.

## Final handoff

Report changed artifacts, exact commands and results, relevant warnings or failures,
and what remains unverified. Distinguish documentation validation, behavioral
verification, installation, and activation. If a check is blocked, say why and
what evidence would resolve it. Never upgrade “likely” into “verified.”
