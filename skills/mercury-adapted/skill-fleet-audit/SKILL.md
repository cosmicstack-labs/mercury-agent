---
name: mercury-skill-fleet-audit
description: Audit a Mercury skill pack end to end — discovery, frontmatter, resolvable references, tool syntax, install round-trip — and report PASS/FAIL per skill.
category: software-development
id: software-development/skill-fleet-audit
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the installed Hermes skill-fleet-quality-audit workflow, retargeted to Mercury's SkillLoader and native checks; no upstream text, references or SkillEvaluator dependency bundled.
license: MIT
intents: [audit all my skills, check my skill pack quality, validate skills before shipping, find broken skill references]
tags: [skills, audit, validation, quality]
---

# Mercury Skill Fleet Audit

Curated independent workflow, not a verified self-made procedure. Batch-validate a Mercury skill pack with native checks, triage findings, and apply only approved fixes. No external evaluator is bundled or required.

## Scope

Default to the pack the user named, or Mercury's active discovery roots. A machine-wide census and a runtime capability audit answer different questions, so state which one you are doing. Reconcile physical directories, discovered skills, and installed copies before reporting totals, and explain disabled or excluded entries instead of calling them missing. Distinguish a full `SKILL.md` read, reference inspection, static validation, and live execution: record exactly which happened. A readable skill proves nothing about a service it calls.

Keep the audit read-only for installed artifacts and external systems. Discovery is not permission to enable skills, launch apps, fire jobs, or relink accounts. Repairs need their own approval.

## Procedure

1. **Inventory fresh.** Never assume prior state. Enumerate with a bounded script through `run_command` rather than a broad home search, and record exactly which roots were walked. For this repository's curated pack, `skills/mercury-adapted` is the root and each skill is one directory holding `SKILL.md`.

```bash
python3 - <<'PY'
import pathlib, yaml
root = pathlib.Path("skills/mercury-adapted")
for p in sorted(root.glob("*/SKILL.md")):
    text = p.read_text()
    fm = text.split("---")[1]
    meta = yaml.safe_load(fm)
    print(p.parent.name, "|", meta.get("name"), "|", meta.get("version"), "|", len(meta.get("intents") or []))
PY
```

2. **Validate each skill on its own.** Do not validate a parent directory and call it the fleet; nested and plugin-owned paths get skipped that way. For each exact directory check: frontmatter parses and carries `name`, `description`, `version`, `author`, `license`, `intents`; the directory name matches the frontmatter name; the body is substantial enough to be a procedure rather than a stub; every backticked `mercury-*` reference resolves to a real skill in the same pack; and no vendor-only syntax survives from the source — upstream skill-management and shell tool names written as function calls, upstream memory-service calls, and paths baked to another agent's home directory all count.

3. **Verify the discovery contract.** Load the pack through the real loader with `seedDefaults: false` and assert the discovered name set exactly equals the intended set — a count check alone hides a rename. Confirm the loader can install each skill into an isolated temporary root and reload it with identical bytes; that round trip is what proves the file is installable rather than merely readable.

4. **Triage every failure into one of four buckets** before proposing anything: a real defect in frontmatter or body; a stale reference to a renamed or removed skill; a deliberate adaptation choice that a generic checker misreads (for example Mercury's flat `skills/<pack>/<slug>` layout, `## Procedure` instead of `## Instructions`, or local paths that belong in the body); or an unresolved question needing the user. Bucket three is a false positive: document it and do not "fix" it.

5. **Propose fixes, do not apply them.** Edits to installed or shipped skills need exact approval. When editing frontmatter, preserve folded YAML scalars and any attribution, and verify the result with a real YAML parse — re-serializing the whole block can silently rewrite a multi-line description. Keep each `---` delimiter on its own line.

6. **Re-run the whole fleet after approved changes**, not only the changed skills, because a rename or removal breaks references elsewhere. Report `N PASS / M FAIL / total`, the score or check coverage if one was computed, and every remaining failure with its documented reason.

## Reporting honesty

Keep the layers separate when summarizing: static validation, install round-trip, and live execution are different kinds of evidence. Passing checks prove the files parse and install, not that the workflow they describe works against a real service. Say which layers ran. If a check could not run, report the blocker rather than a pass.

Never hide a failing skill inside an average score. Group remaining failures by exact cause so the user can decide what to fix first.

## Related

Use `mercury-skill-install-security-gate` before adopting a skill from an outside source, and `mercury-skill-security-triage` when a scanner has already produced findings. Use `mercury-writing-for-agents` when a passing audit still leaves a document that reads badly or triggers unreliably.

## Completion check

Deliver the enumerated inventory with each skill's status, the exact discovery name set, the install round-trip result, the failure list with causes, and the precise proposed next action. Confirm whether anything was modified. Loading this skill audits nothing by itself.
