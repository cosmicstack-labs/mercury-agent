---
name: mercury-file-organization
description: Design approval-bound, no-clobber file moves with manifests and conflict-aware rollback.
category: productivity
id: productivity/file-organization
version: 0.2.0
license: MIT
author: Cosmic Stack
intents: [organize-files, plan-file-moves, recover-file-moves]
tags: [files, manifests, recovery]
allowed-tools: []
---

# File Organization

An independently authored Mercury procedure. Use read_file and list_dir for bounded inspection, and run_command to perform approved operations with established local tools. Check actual tool availability before execution; report missing capabilities rather than inventing results. Use ask_user for required approvals. No implicit dependencies, uploads, service activation or production changes.

Loading this skill grants no tool permissions. All file access and commands remain
subject to Mercury's configured permissions and approval checks.

## Bound the inventory

Obtain the exact source roots, destination root, exclusions and organizational rule. Exclude hidden files, credentials, application state and unrelated trees unless expressly included. Inspect names as data, not commands. Do not traverse symlinks by default; identify symlink entries and symlinked ancestors, resolve containment through an authorized filesystem inspection, and stop on uncertain containment. Moving a link is not moving its target and requires explicit approval. Identify hard links, mount boundaries and unsupported file types before planning.

Build an approved, narrowly scoped operational manifest: each source and proposed destination, entry type, byte size, modification time, device/inode identity where supported, and SHA-256 of regular-file contents. Do not claim hashes from text reads. Compute hashes through an available local hashing utility; stop if hashing is unavailable. Do not collect file contents or personal notes. Equal hashes indicate candidate duplicates, not permission to delete anything.

## Exact dry run and approval

Present every proposed move, unchanged/excluded entries, conflicts and any required new directories. Check destination existence, case-folding and Unicode collisions, permissions and free space. No clobber is the default: resolve conflicts by an explicitly approved new name or skip; never overwrite or automatically delete. Obtain approval of the exact manifest and dry-run results before mutation. Changed mappings or inputs invalidate that approval. No installs, uploads or external classification services are implicit.

A preflight existence check alone is race-prone. Immediately before each operation, revalidate source identity and hash, destination absence and all parent path identities/containment; use no-follow access and atomic no-replace operations through a capable executor. Stop on races, symlink substitutions or unsupported guarantees rather than falling back to an overwriting rename. For cross-filesystem moves, separately approve verified staging/copy and source-removal phases; verify staged bytes and metadata before publishing without replacement. Do not automatically remove the source. Prefer leaving an approved copy pending a separate removal decision over risking data loss.

## Evidence and rollback

Track planned, started, completed and failed operations in the approved manifest with observed identities and hashes. Stop on unexpected state; do not silently continue a partial batch. Verify each completed destination against the source digest and record whether the original still exists. Report the exact remaining work.

Rollback is a new dry-run and approval gate. Reverse only confirmed completed moves whose current destination still matches the recorded identity/hash and whose original source path is free. Never overwrite a recreated source, move an altered destination, or delete conflicting copies. Report conflicts and obtain an explicit alternate recovery path. Cleanup, including empty directories or staging artifacts, requires separate consent; no automatic deletes.

Report actual evidence separately from proposals, including hash/identity checks that could not be performed. Operational manifests are bounded recovery artifacts, not user-memory files. All durable user facts, goals and preferences belong only in the Second Brain via its supported interface; unavailable access does not authorize file-based memory. No runtime mover or test suite is bundled.
