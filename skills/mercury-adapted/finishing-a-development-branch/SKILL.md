---
name: mercury-finishing-a-development-branch
description: Close out approved development work with scoped verification, explicit Git authority and safe workspace preservation.
category: development
id: development/finishing-a-development-branch
version: 0.1.0
license: MIT
author: 'Cosmic Stack; adapted from Hermes Agent and obra/superpowers'
intents: [finish-development-branch, preserve-recovery-checkpoint]
tags: [git, release, verification, worktree]
allowed-tools: [read_file, list_dir, run_command, cd, ask_user]
---

# Finishing a Development Branch

Separate source preservation, passing acceptance checks, publication and runtime activation. A commit proves none of the latter three by itself.

## Bind the requested outcome

Inspect repository, branch, HEAD, worktree registration, staged and unstaged changes, and approved untracked paths. Identify the intended base from evidence or ask; do not infer it merely because a branch named main exists. Preserve other owners' changes and existing staged files.

If the user already selected a local checkpoint, commit, merge or publication, honor that choice within its exact scope. Otherwise use `ask_user` to choose keep-as-is, local integration, publication, or explicitly scoped discard. Never silently merge or publish because tests pass.

## Verification gate

Read repository guidance and scripts, inspect side effects, then run the installed canonical checks for the approved candidate. Report commands, exit codes, test selection and counts. Targeted tests are not a full-suite pass. Use `mercury-verification-before-completion` to tie claims to exact bytes.

Failing acceptance checks block release-ready claims and integration. An explicitly requested recovery checkpoint may preserve failing work, but must disclose failures and remain labeled not release-ready. Do not install dependencies, repair source, alter tests or bypass hooks to manufacture a passing result without separate exact approval.

## Authorized operations

- Before a commit, recheck HEAD and staged diff against approved paths and content. If unrelated staged changes exist, stop rather than unstaging or including them. Stage only approved paths; avoid blanket staging. Use the repository's ordinary commit path. If a wrapper cannot handle a worktree `.git` file, use `run_command` with `git commit -F <message-file>`; create that message through a file tool if available, or use a safely quoted `git commit -m` for a short message. Do not invent file-tool availability.
- A failed hook is a blocker, not permission for `--no-verify`. Any one-shot bypass requires explicit approval and disclosure; never persistently change hook configuration.
- Before merge, identify the actual target worktree using `git worktree list --porcelain`, check its state and obtain approval for the precise operation. Do not derive a checkout path by trimming the Git common directory or run an unrequested pull. Verify the merged result with relevant tests before suggesting cleanup. On conflict, preserve state and report; no automatic reset.
- Push and PR creation require explicit destination and content authority. Discover available external integration tools before use; remote operations are not implied by a local commit. Verify resulting remote identity when authorized.
- Discard requires fresh confirmation of exact branch, commits, uncommitted files and worktree affected. Directory location is not ownership evidence. Do not remove pre-existing or host-managed worktrees, use force removal, or prune unrelated registrations. Keeping work and publishing a PR both preserve the workspace by default.

## Receipt

Return operation, exact commit/hash if created, verification scope/results, working-tree status and remaining blockers. Explicitly state whether anything was pushed, installed, restarted or activated. A local commit is not an off-machine backup. Never label an unexecuted operation complete. Durable user knowledge belongs in the Second Brain; do not create parallel memory files.
