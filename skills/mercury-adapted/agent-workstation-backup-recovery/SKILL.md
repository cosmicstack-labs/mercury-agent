---
name: mercury-agent-workstation-backup-recovery
description: Scope encrypted workstation recovery artifacts and prove isolated restoration with measured evidence.
category: devops
id: devops/agent-workstation-backup-recovery
version: 0.2.0
license: MIT
author: Cosmic Stack
intents: [plan-agent-backup, restore-agent-workstation, drill-agent-recovery]
tags: [backup, sqlite, recovery, isolation]
allowed-tools: []
---

# Agent Workstation Backup and Recovery

An independently authored Mercury procedure, not a backup engine. Use read_file and list_dir for bounded inspection, and run_command to perform approved operations with established local tools. Check actual tool availability before execution; report missing capabilities rather than inventing results. Use ask_user for required approvals. No implicit dependencies, uploads, service activation or production changes.

Loading this skill grants no tool permissions. All file access and commands remain
subject to Mercury's configured permissions and approval checks.

## Narrow consent and recovery goals

Agree on exact included paths, exclusions, destination, access controls, retention, encryption method and recovery-key custody. Enumerate only necessary configuration, approved workspace artifacts and the Second Brain database; do not archive an entire home directory by default. Exclude logs, caches, browser profiles, credential dumps and unrelated personal material. Secrets are excluded by default; including specific secret-bearing configuration requires separate consent and encryption before persistence to the backup destination. Never print secrets, keys or decrypted payloads into chat or diagnostics. Keep keys outside the archive under separately approved custody, and verify that the recovery operator can access them.

Set target RPO (maximum tolerable age of recoverable data) and RTO (maximum tolerable time to validated recovery). These are goals, not guarantees. Obtain approval for the exact scope and side effects before writing the artifact. Remote storage, service downtime and retention deletion each need explicit consent; never automatically delete older backups.

## Consistent capture

Check availability and versions of existing backup, encryption and SQLite tooling before proceeding. Missing dependencies block execution, not trigger installation. For a live Second Brain, use its supported snapshot/export facility if it guarantees a consistent SQLite snapshot, or the SQLite online backup API through an authorized integration. Verify the resulting snapshot rather than copying a live database file.

WAL mode can contain committed data absent from the main database. Copying the main file alone, independently copying a changing database/WAL pair, or deleting WAL/SHM is not a valid snapshot strategy. If API snapshotting is unavailable, obtain explicit downtime approval, stop all writers and close connections cleanly, then use a documented consistent offline backup procedure with verified checkpoint state and all required files. If consistency cannot be established, stop. Coordinate related configuration capture or disclose cross-file consistency limits.

Capture a minimal operational manifest: approved scope, exclusions, versions/schema, snapshot boundaries/time, artifact size, cryptographic digest, encryption verification and actual errors. Avoid sensitive path disclosure in shared reports. Encrypt sensitive artifacts using established authenticated encryption; restrict permissions and avoid unapproved plaintext staging. A backed-up Second Brain is a recovery artifact, never an alternative active memory store. Persistent user knowledge remains exclusively in the live Second Brain through supported interfaces.

## Isolated restore drill

Obtain separate approval for a fresh restore directory or disposable environment, required resources and cleanup policy. Never overwrite production state. Before decrypting or starting restored components, deny outbound network access and disable daemon autostart, sends, webhooks, scheduled tasks, background workers and integrations. Restored configuration and secrets must not activate live actions. If this isolation cannot be demonstrated, do not start the agent; perform offline checks only and report the limitation.

Verify archive digest and authenticated decryption, restore into the isolated location, and run SQLite integrity_check on the restored snapshot (require the actual result, normally `ok`). Also check schema compatibility, required tables and non-sensitive logical invariants; integrity alone does not establish completeness. Use only an isolated database handle for read checks, never redirect the live daemon. Do not copy user knowledge into notes as a verification shortcut. Test essential offline recovery functions without sends or external calls; document checks skipped for isolation.

Measure actual snapshot age at the drill's reference incident time for achieved RPO, and elapsed time from restore start through validated readiness for achieved RTO. Report timestamps, duration, bytes/digests, integrity results, isolation evidence and failures against the agreed goals. Offline readiness excludes production activation time unless actually measured. A successful backup command without a restore drill is not verified recovery.

Production cutover requires a separate approved plan, live-state protection and rollback. Do not enable daemons, integrations or schedules as a side effect of a drill. Retain or remove test artifacts only according to explicit consent. No runtime scripts, scheduled jobs or bundled backup dependencies are provided.
