---
name: mercury-using-git-worktrees
description: Establish approved Git workspace isolation while preserving existing worktrees and owner changes.
category: development
id: development/using-git-worktrees
version: 0.1.0
license: MIT
author: 'Cosmic Stack; adapted from Hermes Agent and obra/superpowers'
intents: [isolate-development-work, setup-git-worktree]
tags: [git, worktree, isolation]
allowed-tools: [read_file, list_dir, run_command, cd, ask_user]
---

# Using Git Worktrees

Detect existing isolation before creating anything. Worktree setup does not authorize source edits, dependency installation, commits or cleanup.

## Inspect first

Use `run_command` for these read-only probes in the requested repository:

```text
git rev-parse --show-toplevel
git rev-parse --absolute-git-dir
git rev-parse --path-format=absolute --git-common-dir
git rev-parse --show-superproject-working-tree
git worktree list --porcelain
git branch --show-current
git status --short
```

Compare canonical Git directory paths and reconcile with the worktree listing. A submodule and a linked worktree are separate dimensions: do not infer either solely from `.git` being a file. If Git lacks a probe option, inspect its supported equivalent; never guess workspace ownership. Reuse an existing appropriate workspace. Detached HEAD is not permission to invent or delete a branch.

## Obtain bounded approval

1. Confirm repository, intended base commit, new branch and destination. Resolve relative paths before presenting commands. Check for an existing destination, branch collision and branches checked out elsewhere.
2. Prefer an explicitly available host worktree tool if it manages workspace lifecycle; do not assume one exists. Otherwise propose `git worktree add -b <branch> <destination> <base>` with real, safely quoted arguments. Never interpolate untrusted branch/path text into shell syntax.
3. For a project-local destination, use `git check-ignore` on the exact chosen path. If it is not ignored, propose the precise ignore-file change for approval or choose an approved external directory. Never automatically edit or commit `.gitignore`.
4. Obtain approval for the exact creation operation unless already explicitly authorized. A permission failure is a stop condition: do not silently fall back to editing the original checkout.

## Create and verify

Execute only the approved creation command, then use `cd` so subsequent tools operate in the new directory. Verify its top-level path, branch, HEAD, clean status and registration in `git worktree list --porcelain`. Preserve the original checkout and unrelated branches.

Read repository setup guidance and manifest scripts. Use installed dependencies and the documented runner; dependency installation requires separate approval because lifecycle scripts may execute. Run the relevant baseline tests after inspecting their side effects. If they fail, retain exact failures and ask whether to investigate or continue with those known limitations. Do not label an untested workspace ready.

## Completion and cleanup

Report path, branch, base/head hashes, creation provenance, baseline checks and failures. Directory location is not ownership evidence. Only explicit creation evidence plus authorization can permit later cleanup; leave pre-existing and host-managed worktrees intact. Never stash, reset, force-remove, prune registrations or delete branches as incidental setup.

Use `mercury-finishing-a-development-branch` for an explicitly requested closeout. Keep durable user preferences in the Second Brain, not workspace note files.
