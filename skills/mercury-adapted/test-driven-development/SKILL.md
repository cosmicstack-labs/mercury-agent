---
name: mercury-test-driven-development
description: Build behavior in small RED-GREEN-REFACTOR cycles with honest failure evidence.
category: development
id: development/test-driven-development
version: 0.1.0
author: Mercury
attribution: Adapted from Hermes Agent test-driven-development 1.1.0, derived from obra/superpowers.
license: MIT
tags: [testing, tdd, development, regression]
intents: [implement tested behavior, fix bugs with regression tests, refactor safely]
allowed-tools: [read_file, list_dir, run_command, create_file]
---

# Mercury Test-Driven Development

Curated adaptation of the upstream skill, not a self-made verified procedure.
Use for new behavior and bug fixes; protect existing behavior before refactoring.
Prefer one small behavior slice per cycle over a speculative batch of tests.

## Approval and preservation

- Get explicit approval before source/config edits, including test-file edits.
- Work only within the approved scope; request approval for material expansion.
- Approval to implement is not approval to install dependencies, use external
  services, deploy, restart services, delete work, commit, or push.
- Obtain exact approval for consequential actions; never auto-commit or push.
- Inspect `git status --short` and relevant diffs before editing.
- Preserve owner changes and unrelated work; never destructively revert or stash
  a dirty owner tree to obtain a convenient baseline.
- Do not delete existing implementation merely because it predates the test.
- Store user knowledge only through available Second Brain tools, not diary files.

## Prepare the smallest useful slice

1. Read requirements and identify the externally observable behavior.
2. Inspect existing tests, scripts, conventions, and the affected implementation.
3. Choose an existing runner; do not install a framework without approval.
4. Define a narrow test with meaningful inputs and an unambiguous expected result.
5. Establish relevant baseline failures so new regressions are distinguishable.

Use `read_file`, `list_dir`, and `grep` through `run_command` for discovery.
Run tests with `run_command`, not a tool named terminal.

## RED: demonstrate missing or broken behavior

Write one focused test with a descriptive behavior name.
Prefer exercising real code; use fakes at costly or unsafe boundaries.
Mocks should model dependencies, not replace the behavior being tested.

Run the specific test and read the full output and exit code:

```text
run_command(command="pytest tests/test_feature.py::test_specific_behavior -v")
```

This is an illustrative Python command; use the repository's actual runner/path.

Confirm all three:
- The intended test was discovered and executed.
- Setup succeeded far enough to exercise the target behavior.
- The assertion failed for the intended missing or incorrect behavior.

Import, syntax, compilation, fixture, dependency, and environment errors are setup
failures, not behavioral RED. Repair setup within approval, then rerun.
If introducing a new API, prefer a runnable behavior assertion over an import
failure; report an unavailable API honestly rather than calling it behavioral RED.
If the test passes immediately, investigate whether behavior already exists or
whether the test misses it. Do not manufacture a failure just to satisfy a ritual.

## GREEN: implement only the required behavior

1. Make the smallest sound implementation change covered by current approval.
2. Rerun the exact test and inspect its completed result.
3. Run neighboring tests and the broader relevant suite when feasible.
4. Investigate regressions rather than weakening assertions to conceal them.

Avoid unrelated cleanup and speculative features. A minimal implementation must
still honor the real contract; hardcoding the fixture is not a finished solution.
Warnings and known failures must be understood and reported, not silently ignored.

## REFACTOR: improve structure while preserving behavior

- Once green, simplify names, duplication, or structure within approved scope.
- Rerun affected checks after each meaningful change.
- If a refactor breaks tests, inspect and correct your own change in small steps.
- Never use broad checkout, reset, or stash operations to undo owner work.
- Add the next behavior as another RED-GREEN cycle, not a pile of imagined tests.

## Existing code, exceptions, and constrained testing

For code already implemented, add characterization or regression coverage without
claiming test-first history. A passing new test alone does not prove it detects
the old defect. With approval, compare against an isolated baseline or controlled
mutation outside the dirty owner tree; distinguish setup errors from detection.

For documentation, generated output, exploratory work, or untestable environments,
agree on proportionate validation and state the exception. Do not force irrelevant
unit tests or delete useful work to retroactively label the process TDD.
Manual checks can supplement tests; record steps and limits when they replace them.

## Completion evidence

Report exact commands, actual counts and failures, test selection, and artifact
scope. Separate RED evidence, GREEN evidence, existing failures, and unrun checks.
Inspect the diff for unintended edits. Use `mercury-verification-before-completion`
before claiming the behavior is fixed or the task is complete.
