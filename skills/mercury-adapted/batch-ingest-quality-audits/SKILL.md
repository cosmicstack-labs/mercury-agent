---
name: mercury-batch-ingest-quality-audits
description: Audit bounded bulk transformations for schema, integrity, provenance, and count reconciliation.
category: productivity
id: productivity/batch-ingest-quality-audits
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the installed Hermes batch-ingest-quality-audits workflow; no upstream text or scripts bundled.
license: MIT
intents: [audit a bulk ingest, verify converted files, reconcile batch outputs]
tags: [audit, integrity, provenance]
---

# Mercury Batch Ingest Quality Audits

Curated independent workflow, not a verified self-made procedure. File existence is not evidence that a bulk transformation preserved its inputs or generated correct claims.

## Boundaries

Begin read-only. Approval for an audit does not authorize repairs, deletion, promotion, indexing changes, or another full-vault scan. Obtain exact approval for source/config edits or consequential actions. Keep persistent user knowledge in Second Brain, not audit diaries. Approved task reports may describe technical findings but must not become an alternative memory store.

## Procedure

1. Read the requested schema and transformation contract. Freeze the batch's exact source/output paths, input list, expected types, permitted normalization, and generated-artifact set. Separate pre-existing defects from new ones.
2. Inventory the bounded input and output trees with an established CLI or one bulk-analysis script through `run_command`. Avoid hand-reading every file when a parser can check structure. Preserve source-to-destination identity, not just equal file counts. Identify collisions, duplicates, unsupported inputs, and unexpected omissions.
3. Parse metadata with the correct parser. Validate required fields, types, taxonomy values, timestamps, and resolvable source references. Report exact denominators and representative paths. A syntactically present field is not necessarily correct.
4. Recompute checksums against the actual preserved content. Use the documented normalization only; do not strip arbitrary bytes until hashes match. Distinguish absent, malformed, mismatching, and unverifiable digests. If originals are unavailable, do not claim preservation was proved.
5. Trace important generated claims to source passages. Confirm entity identity from full context rather than surname overlap. Recompute promotion thresholds over distinct sources if required. A manifest edge or extraction count is a lead, not proof.
6. If a sample reveals a systematic resolver or transformation fault, identify and inspect the affected batch-wide blast radius. Request approval before expanding beyond the approved batch. Until checked, report the unresolved risk as a blocker rather than extrapolating a pass.
7. Reconcile indexes against actual outputs in both directions. Resolve links under the real naming rules, including permitted staging targets. Separate examples and intentional stubs from genuine missing destinations. Judge document quality against its role, not bullet count or text length alone.
8. Scan only the approved scope for potential secrets and sensitive data using appropriate local tools. Do not print secret values. Record exclusions and candidate versus confirmed counts; pattern matches alone are not proof. Wider inherited findings belong in a separate category.
9. For high-stakes batches use a fresh reviewer through `delegate_task` with explicit read-only tools and the frozen contract. Reconcile findings against bytes and source passages; reviewer agreement is not deterministic evidence.
10. Deliver a requirement-by-requirement result: PASS, FAIL, or UNVERIFIABLE; checked/total; evidence; impact; proposed remedy. State whether the batch is usable, blocked, or requires bounded fixes before release. Do not hide critical integrity failures in an average score.

## Verification

Read command output as well as exit status. A successful linter process may report defects in its payload. Clearly separate exhaustive checks from samples and structural checks from semantic judgments. Do not repair while auditing without approval; propose precise changes and rerun the same checks after approved remediation.
