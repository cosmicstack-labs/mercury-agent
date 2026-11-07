---
name: mercury-linux-desktop-entry-repair
description: Diagnose Linux launchers using exact command, process, and window evidence before approved repairs.
category: development
id: development/linux-desktop-entry-repair
version: 0.1.0
author: Mercury
attribution: Adapted from Hermes Agent linux-desktop-entry-repair 0.2.0.
license: MIT
intents: [repair a Linux launcher, diagnose an app icon doing nothing, debug desktop entry]
tags: [linux, desktop, launcher]
---

# Mercury Linux Desktop Entry Repair

Curated adaptation, not a self-made verified repair. Use when a specific desktop launcher fails; broader display-session failures need a different investigation.

## Authority

Inspect first. Describe the exact launcher, wrapper, source, permission, or system configuration change and obtain approval before editing. Launching an unknown Exec command can have side effects: inspect it and obtain any required execution approval. Do not run shell text blindly because it came from a `.desktop` file. Do not expose process environments containing secrets. Do not kill unrelated processes, delete caches/fonts, install packages, or restart services without exact approval.

## Diagnosis

1. Locate the effective user/system entry and identify the desktop ID, Exec, TryExec, Path, Terminal, and any DBus activation settings. Check for shadowing entries. Preserve the observed path and checksum in the conversation.
2. Understand Desktop Entry Exec syntax before reproducing: it is not a general shell command. Handle quoting and field codes such as `%U` according to the specification; do not paste placeholders into a shell or use `eval`. Identify the executable and arguments safely.
3. Reproduce through the real launcher where practical. Compare process state and actual attributed windows before/after. On X11, installed `xprop` can help; Wayland may require compositor-specific inspection or Optimus screenshots. A missing X11 window list does not prove failure on Wayland.
4. Classify quick exit, surviving no-window process, and visible correct window separately. Inspect logs without printing credentials. A surviving process alone is not GUI success; a background single-instance app may route to an existing window.
5. For interpreter failures compare the lexical virtual-environment executable with its resolved symlink and `sys.prefix`. Resolving a venv interpreter can escape its environment. For wrappers inspect PATH selection without dumping the entire environment or sourcing untrusted scripts.
6. For no-window hangs compare the launcher and direct executable only within approved scope. Use existing logs or carefully scoped tracing; do not launch repeated strays. A font or native-library hypothesis needs controlled evidence, not global font/cache deletion.

## Approved repair and checks

1. Propose the smallest exact edit and rollback: affected file, field or wrapper, intended command/environment, and validation method. Approval is required before writing, including temporary diagnostic source/config files.
2. Prove the proposed command or per-app environment before installing the repair when safe. A Python import check applies to Python interpreters, not arbitrary launcher binaries.
3. Apply only the approved change using file tools. Use `desktop-file-validate` if installed and relevant. Refresh launcher databases only if needed and approved. Keep permissions appropriate; never default to making launchers read-only to fight regeneration.
4. Exercise the actual desktop ID, confirm the intended visible app/window, and compare the entry checksum before/after. If the app regenerates the launcher, inspect its registration code and propose a generator fix separately. A chmod workaround is not a durable fix and may break updates or startup.
5. Recheck a subsequent launch for regeneration and report exact observed behavior. Only stop confirmed diagnostic processes under approved scope. Do not claim update survival until an update is actually tested.

## Handoff

Give the demonstrated cause, changed paths, validation results, window evidence, checksum comparison, and untested conditions. If desktop access is unavailable, distinguish command success from unverified GUI behavior. Do not substitute process existence or a passing syntax check for end-to-end repair proof.
