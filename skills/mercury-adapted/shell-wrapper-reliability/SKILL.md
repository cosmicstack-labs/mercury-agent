---
name: mercury-shell-wrapper-reliability
description: Specify reliable shell boundaries for exit status, structured output and bounded process lifetime.
category: development
id: development/shell-wrapper-reliability
version: 0.1.0
license: MIT
author: Cosmic Stack
intents: [harden-shell-wrapper, validate-shell-output-boundaries]
tags: [shell, reliability, process-control]
allowed-tools: [read_file, list_dir, create_file, run_command, ask_user, use_skill]
---

# Shell Wrapper Reliability

An independently authored Mercury procedure, not an executable wrapper. Use read_file and list_dir for bounded inspection, and run_command to perform approved operations with established local tools. Check actual tool availability before execution; report missing capabilities rather than inventing results. Use ask_user for required approvals. No implicit dependencies, uploads, service activation or production changes.

## Approval and contract

Before writes or execution, obtain explicit approval naming exact files, command arguments, working directory, environment inputs, temporary paths, process cleanup scope and limits. Approval for inspection does not approve execution. Separately approve dependency changes, network access, service activation or persistent configuration; none is implicit. A denied action stops, without retries through another route.

Freeze the public contract: payload grammar and encoding, stdout versus stderr roles, exit semantics, maximum output bytes, absolute deadline and idle deadline. Preserve the child's actual exit status by capturing it immediately, before logging or cleanup. Pipelines must have an explicit status policy; do not silently substitute the last logger's success. Distinguish child failure, signal termination, timeout, parse failure and wrapper failure, without masking the original status. Document mappings where an OS cannot represent these states directly.

Keep stdout parseable: no banners, progress or diagnostic text inside a machine payload. Stderr carries bounded diagnostics, redacted for secrets; never merge it into stdout unless the contract explicitly defines a framed combined stream. Drain both streams concurrently to avoid pipe deadlock. Handle byte truncation and invalid encoding as explicit incomplete evidence, not valid empty output.

If completion uses a sentinel, define exact framing, a per-invocation unpredictable token, producer and consumer ownership, and collision/escaping rules. Require a complete frame and reconcile it with process exit; a sentinel alone never proves success. Untrusted child text cannot authenticate completion merely by repeating the token. Do not detect completion with substring matching or a trailing newline assumption.

## Bounded local verification plan

Use synthetic, secret-free fixtures only. After approval, execute at most twelve cases, each with a five-second absolute timeout, two-second idle timeout, one MiB captured-output cap and a sixty-second total budget; obtain approval before changing these limits. Cover successful structured output, nonzero exit with valid payload, malformed payload, sentinel absent/duplicated/spoofed, empty output, stderr-only output, output flooding, a hung child and a descendant retaining a pipe. Include signal interruption and cleanup behavior where the host supports them.

Liveness is separate from completion: activity may reset an idle timer but never the absolute deadline. On expiry, terminate only the owned process group, allow a fixed one-second grace period, then force termination where supported and reap children. Never kill by broad process-name matching. Report unsupported cleanup semantics and leaked descendants rather than claiming a clean stop.

Report observed exit, parse result, completion evidence, timing, truncation and cleanup separately. This skill bundles no runtime or tests. Project diagnostics are not a memory store: persistent user facts, preferences and goals belong only in the Second Brain; if its capability is unavailable, do not save them to files.
