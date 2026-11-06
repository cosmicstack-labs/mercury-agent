---
name: mercury-resumable-batch-extraction
description: Run large independent extraction jobs against rate-limited or flaky sources with a frozen manifest, durable checkpoint and deterministic reconciliation.
category: integrations
id: integrations/resumable-batch-extraction
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the installed Hermes resumable-batch-extraction workflow; no upstream text, case studies or scripts bundled.
license: MIT
intents: [extract hundreds of items, batch download or convert, resume an interrupted batch, reconcile bulk extraction output]
tags: [batch, extraction, checkpoint, reconciliation]
---

# Mercury Resumable Batch Extraction

Curated independent workflow, not a verified self-made procedure. For the audit side of a finished batch use `mercury-batch-ingest-quality-audits`; this skill covers building and operating the job.

## When to use

Tens to thousands of independent items that share one extraction schema, where upstream access is rate-limited, flaky or selectively unavailable. Signals: HTTP 429, IP blocking, anti-bot challenges, transient timeouts, egress rejection, or a prior attempt that died mid-run.

Not for a single item, a tightly coupled transaction, or any source whose ordering changes item semantics. Never use route rotation to bypass authorization, paywalls, private content or access controls — it is for resilient access to content the user may legitimately retrieve.

When a full-corpus run is already authorized, tracked batching and duplicate reconciliation are execution details: do not re-ask merely because the run exceeds one session. That does not authorize source or configuration edits, external sends, or sampling. Any change to the frozen manifest, destination, or route set needs exact approval, and deleting or overwriting existing artifacts needs its own.

Read-only inspection of the source needs no approval. Writing scratch probes, a manifest and checkpoint files under a report directory is part of the authorized job; publishing, uploading or moving results into a shared location does not follow from that approval.

## Procedure

1. Freeze the manifest before retrieval. Fix the catalog boundary first — a reported total may include record types the user excluded, so enumerate the exact endpoint, tab or query in scope. Enumerate the whole in-scope source, deduplicate by stable source ID (never title or filename), and store index, ID, name, locator and cheap metadata. Verify the count and keep it as the reconciliation denominator. Hash the frozen manifest when workers must later prove they read the same bytes. Never combine discovery and extraction in one unbounded loop: a moving source makes completion unprovable.
2. Prove one end-to-end item. Run one to three representative items through retrieve, parse, render, atomic save (`.tmp` then rename), then reopen and validate metadata, size, structure and source ID. Only then fan out. A route that lists metadata may still be unable to fetch the payload, so probe real payloads rather than just discovery. Keep probes in scratch with renumbered fields and a recomputed checksum instead of editing the production manifest.
3. Use a durable per-item checkpoint written by a fresh process:

```json
{
  "id": "stable-source-id",
  "status": "ok | permanent_failure | retryable_failure",
  "artifact_path": "/absolute/path/or/null",
  "bytes": 12345,
  "source_metadata": {},
  "route": "direct | named-egress",
  "error_type": "exact class or null",
  "error": "bounded exact message or null"
}
```

Write the artifact atomically first, then the checkpoint. On resume skip an item only when the status is `ok`, the artifact exists, and it passes a minimum integrity check. Bound stored error length but keep the exact class.
4. Route failures instead of blind retries. Permanent item state (deleted or private source, captions disabled, no matching content, unsupported record) is recorded and the run continues. Retryable route state (429, IP block, timeout, anti-bot, egress rejection) triggers a route change or cooldown and never marks the item missing. Unknown errors keep the exact message; allow one transient retry, then require a new hypothesis.
5. Widen routes before workers. Reduce concurrency and add jitter, respect retry-after, add independent approved egress paths, isolate workers per route, and only then raise worker counts — all on routes already proven healthy.
6. Isolate failure. A blocked worker requeues its current item and cools down; a permanently unavailable item becomes a failure record rather than killing the run; a killed process loses at most unwritten items. Report completed artifacts, failures and route changes separately. Never report a live background process as completion.
7. Reconcile deterministically in code rather than by agent: manifest IDs must equal successful plus permanent-failure plus explicitly remaining retryable IDs. Assert no successful ID lacks an artifact, no artifact has an unknown or duplicate ID, every artifact parses and meets size and structural checks, filenames are collision-safe and carry the stable ID, and the human-readable failure list matches the checkpoint records.

## Specific pitfalls

- Status-only resume is not enough; revalidate the artifact's existence and integrity.
- Title-based identity collides and drifts. Always carry the stable ID.
- A single summary file is not a checkpoint; keep machine-readable per-item state.
- Freeze each extraction before generating line-numbered citations, and never let a second extractor overwrite those inputs. If drift occurs, restore the exact prior text and verify its original hash instead of shortening claimed coverage.
- Catch failure inside each worker. An uncaught subprocess timeout can cancel queued items; persist planned work before fan-out, terminate only that subprocess group, and consume results independently.
- Identical text extracts can conceal different scanned pages. Deduplicate the text-reading component only and keep OCR and visual obligations per original ID.
- Require each chunk to echo its source ID and exact line interval. A model reporting missing input or unreadable OCR is a coverage failure, not permission to mark it read; retry in smaller jobs using the original format.
- Complex formats need their real structure: preserve table rows and cells before interpreting relationships, keep original extraction snapshots when later OCR will shift line numbers, and record layer visibility for layered source files instead of judging a flattened composite.
- Partial progress is not completion. Final reconciliation is the proof.

## Verification receipt

Before saying complete, report: manifest count and deduplication key; successful artifacts; permanent failures grouped by exact error type; retryable failures remaining; missing, orphan and duplicate artifact counts; structural validation failures; and the absolute output directory.

If interrupted, report progress only: checkpoint path, process handle, successful and failed counts, and the remaining verification work. Then run `mercury-batch-ingest-quality-audits` on the finished tree.
