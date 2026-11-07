---
name: mercury-deterministic-release-zip-builder
description: Plan allowlisted, reproducible ZIP releases with safe paths and approval-controlled publication.
category: development
id: development/deterministic-release-zip-builder
version: 0.1.0
license: MIT
author: Cosmic Stack
intents: [build-reproducible-release-zip, audit-release-archive]
tags: [release, zip, reproducibility]
allowed-tools: [read_file, list_dir, create_file, run_command, ask_user, use_skill]
---

# Deterministic Release ZIP Builder

Independently authored Mercury instructions, not a bundled builder. Use read_file and list_dir for bounded inspection, and run_command to perform approved operations with established local tools. Check actual tool availability before execution; report missing capabilities rather than inventing results. Use ask_user for required approvals. No implicit dependencies, uploads, service activation or production changes.

## Freeze inputs and authority

Require an explicit path-by-path allowlist rooted in one approved source directory, a release identifier, destination, approved temporary directories and a pinned locally available archiver/runtime. Do not infer inclusion from a broad recursive glob or repository tracking alone. Exclude credentials, private configuration, caches, VCS internals, sockets, devices and generated staging/output directories. Stop on missing or unexpected allowlisted entries.

Before staging or building, obtain approval for the exact input manifest, output paths, implementation changes, two-build procedure and resource limits. No installation, dependency update, network access or service activation is implied. Before final publication, obtain separate approval naming the final archive, verified digest, destination and replacement policy. Never treat build approval as permission to overwrite or upload a release. A denial ends that action.

Reject symbolic links by default, including symlinked ancestor components. If links are explicitly required, approve a separate link policy first; resolve targets within the source root, exclude escaping targets, loops and dangling links, and never follow a link outside the allowlist. Check canonical containment and file identity again when reading to reduce substitution races. Prefer an immutable input snapshot; fail if size, identity or hash changes during capture.

## Deterministic archive contract

Normalize entry paths to relative forward-slash names. Reject absolute paths, drive/UNC prefixes, NUL, empty or dot/dot-dot components, backslashes, duplicate names and normalization/case collisions relevant to the target platform. Sort normalized names using a documented byte ordering, not locale order. Use one fixed ZIP-compatible timestamp, fixed regular-file modes with explicitly allowlisted executable exceptions, stable UTF-8 flags, fixed compression method/level and pinned compression implementation. Strip variable owner, host, comments and extra fields; explicitly define directory-entry and ZIP64 policy. Do not copy local mtimes or permission bits blindly.

Record each source entry's normalized name, byte count and SHA-256 digest in sorted order. A manifest inside the archive lists payload entries only, avoiding self-hash recursion; report the final archive digest externally. Hash actual captured bytes, not path strings or metadata. Never invent a digest when hashing is unavailable.

## Bounded checks and publication

After approval, execute two isolated clean builds from the same frozen inputs with identical settings. Default ceiling: 1,000 entries, 100 MiB total input, 200 MiB expanded output and sixty seconds per build; stop for approval if exceeded. Compare complete archive bytes or their cryptographic digests, then independently inspect entry order, fixed metadata and per-file hashes. A matching payload alone does not prove reproducible ZIP bytes.

Execute approved local synthetic traversal tests for ../ names, absolute and drive paths, backslashes, duplicate entries, symlink escapes and oversized expansion. Reject malicious archives before extraction; if extraction is tested, use a disposable approved directory, enforce containment and expanded-byte limits, and never overwrite project files. Implement these checks in the approved project; this skill does not bundle test fixtures.

Only after passing checks and receiving publication approval, stage the completed archive on the destination filesystem and atomically rename it into place under the approved no-clobber/replacement policy. Do not delete the old release first; stop if atomic publication cannot be guaranteed. Report inputs, tool versions, two digests, checks, limits and destination. Keep user knowledge exclusively in the Second Brain, never in manifests or memory files; project release evidence must contain no unrelated personal data.
