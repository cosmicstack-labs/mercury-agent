---
name: mercury-systematic-debugging
description: Investigate root causes with a tight reproduction loop before scoped fixes.
category: development
id: development/systematic-debugging
version: 0.1.0
author: Mercury
attribution: Adapted from Hermes Agent systematic-debugging 1.1.0, derived from obra/superpowers.
license: MIT
tags: [debugging, root-cause, regression, investigation]
intents: [diagnose failures, reproduce bugs, investigate regressions]
allowed-tools: [read_file, list_dir, run_command, create_file]
---

# Mercury Systematic Debugging

Curated adaptation of the upstream skill, not a self-made verified procedure.
Use for failing tests, unexpected behavior, integration faults, or performance issues.
Scale the investigation to the problem; do not substitute ritual for evidence.

## Authority and workspace safety

- Read-only investigation does not authorize source or configuration edits.
- Obtain explicit approval for the intended source/config edit scope before writing.
- Existing approval covers only its stated scope; ask again when scope changes.
- Obtain exact approval for consequential actions such as dependency installation,
  network operations, deployment, service restarts, deletion, commits, or pushes.
- Never automatically commit or push, including after a successful test run.
- Inspect `git status --short` and relevant diffs before touching a dirty tree.
- Preserve unrelated owner work; never destructively revert or stash it.
- Diagnostic instrumentation and temporary harness files are edits too.
- Store user knowledge only through available Second Brain tools, never diary files.

## 1. Establish the failure

1. Read the complete error, stack trace, relevant source, and callers.
2. Record expected versus observed behavior, inputs, environment, and revision.
3. Identify the smallest safe command that exercises the actual symptom.
4. Run it and inspect its output and exit status before forming a strong theory.
5. If reproduction is unavailable, state that limitation and collect evidence.

Use `read_file` and `list_dir` for inspection. Search with `grep` via `run_command`:

```text
run_command(command="git status --short")
run_command(command="git diff -- src/affected-file.ts")
run_command(command="grep -R -n -F 'error text' src")
```

Adapt paths and test commands to the actual project; examples are not discoveries.
Never expose tokens or private payloads in diagnostics.

## 2. Tighten the feedback loop

- Prefer an existing targeted test, then a minimal integration or CLI reproduction.
- Assert the exact symptom, not merely that startup or an unrelated check succeeds.
- Separate setup failures from product failures: import errors are not behavioral RED.
- For intermittent failures, record repetitions and reproduction rate; do not promise
  that a few clean runs prove absence of a race.
- Minimize one input, component, or environmental variable at a time.
- Avoid stress runs that risk production state or consume unapproved resources.

A useful loop is fast, repeatable, and capable of detecting the reported defect.
When automation is impractical, specify repeatable manual steps and their limits.

## 3. Locate the root cause

1. Review recent relevant history and uncommitted changes without altering them.
2. Find a comparable working path and read enough context to understand it.
3. Trace suspect data backward through callers to its origin.
4. At component boundaries, compare actual inputs, outputs, state, and configuration.
5. Request approval before adding logs; prefer existing observability where possible.
6. List meaningful differences and assumptions rather than dismissing small ones.

Do not treat the first suspicious line as a confirmed cause.

## 4. Test a falsifiable hypothesis

- State: “If X causes this failure, observing or changing Y should produce Z.”
- Rank plausible alternatives when the evidence is ambiguous.
- Probe the cheapest informative hypothesis first, one variable at a time.
- Record which observation supports or falsifies it.
- If wrong, revise the hypothesis rather than stacking speculative fixes.
- Say what remains unknown; ask for missing domain facts when necessary.

## 5. Implement the approved fix

1. Confirm the approved scope still covers the proposed fix and regression test.
2. Use `mercury-test-driven-development` for a focused failing behavioral test.
3. Change the smallest relevant implementation surface, without unrelated cleanup.
4. Rerun the exact reproduction, related tests, and broader checks as appropriate.
5. Inspect the final diff and remove only your approved temporary instrumentation.

If several attempts fail, stop and reassess assumptions, coupling, and architecture
with the user before widening the change. Three failures are a useful warning,
not proof that an architectural rewrite is required.

## Handoff

Report the cause and supporting observations, exact changed files, commands and
results, and remaining risks. Distinguish reproduced failures, hypotheses, verified
fixes, and untested conditions. A passing targeted test is not a full-suite claim.
Use `mercury-verification-before-completion` before declaring success.
