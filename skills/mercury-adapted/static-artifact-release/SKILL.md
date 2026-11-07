---
name: mercury-static-artifact-release
description: Verify that a published static artifact is the intended bytes and that the live behavior was actually exercised.
category: devops
id: devops/static-artifact-release
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the Hermes static-artifact-release-verification workflow. Its reference payloads are not bundled.
license: MIT
intents: [verify a deploy, check the published artifact is correct, confirm a release went live, validate a static site publish]
tags: [release, deployment, verification, integrity]
allowed-tools: [read_file, list_dir, create_file, run_command, fetch_url, ask_user, use_skill]
---

# Mercury Static Artifact Release Verification

Curated independent workflow, not a verified self-made procedure. It governs the release edge only: proving that what you intended to publish is what a visitor actually receives. Building the artifact belongs to its own workflow.

## Approval boundaries

Reading deployed state, hashing local files and downloading through an authorized path need no separate approval. Publishing, overwriting a deployed version, changing an access policy, rotating a key or deleting retained versions each need explicit approval for that exact action — a general "ship it" does not authorize loosening access controls or revoking credentials.

## The release contract

A successful upload or finalize response is not proof that the intended artifact is live. The release passes only when this chain holds:

```text
intended build bytes = staged bytes = bytes downloaded through the authorized path
```

and the changed behavior was exercised through the deployed surface. Publication, byte parity, rendered behavior and visitor authentication are four separate claims — report them separately. Never loosen access controls to obtain a screenshot; a private site does not become public evidence.

## Procedure

1. **Bind the target and capture a baseline.** Read the deployed version, its access policy, and the deploy helper's real implementation. A helper's command-line arguments are decorative until you have checked which path it actually reads. Preserve a recoverable baseline and compare it against the deployed manifest before editing, so a rebuild cannot silently discard a change made elsewhere. Do not infer the uploader's source path from its arguments.
2. **Stage deliberately and freeze the inputs.** Put the intended artifact at the exact path the uploader consumes and require byte parity with the build output. Compare builds taken from one immutable input snapshot: record input hashes, finish all writes before freezing, and either use a snapshot or a confirmed quiescent window. If something else changes the inputs mid-run, keep the failed evidence and repeat against consistent inputs instead of relaxing the equality check.
3. **Record the digest before publishing.** Compute SHA-256 for the intended source and the staged file; they must match before any upload. Keep the digest with the release note so later comparisons are against the same artifact.
4. **Interpret incremental publish results honestly.** If the intended source changed, an upload is expected. A "skipped, unchanged" result is a warning to re-compare hashes, not proof that the deployment is current.
5. **Fetch through the authorized path and compare bytes.** Download the deployed URL without relying on a browser cache and require a 200 response plus matching SHA-256. For protected sites use the provider's documented owner path or an authorized session, and separately verify the intended access boundary, including that an unauthenticated request is denied as specified. A bare 403 is not proof that an allowlist works.
6. **Bind acceptance to the final bytes.** Rebuild first, hash the final artifact, then point artifact-aware checks at that exact file. A suite that passed before the last rebuild is stale evidence. Capture the runner's real exit status, especially when output is piped through another command.
7. **Exercise the released behavior.** Where possible, open the deployed URL as a normal authorized visitor. Otherwise replay byte-verified downloaded copies locally and label that replay content-only: intercepted or loopback responses do not test visitor sign-in, hosting headers or live routing. For a packaged artifact, extract it into a clean directory and run it from there rather than executing the build tree. For local production of a ZIP, use `mercury-deterministic-release-zip-builder`.
8. **Verify any claimed automation.** If a scheduled publisher is in scope, inspect the existing job before adding another, then trigger the real job with its real publisher and verify the recorded outcome, raw output, enabled schedule, timezone and delivery. Never substitute a hand-run shadow script or an "enabled" flag for an executed job.
9. **Hand off and close.** Report `Deliverable: <URL or absolute path>` and `Verified: <observed check tied to the final artifact>`, and name missing gates as `Blocked:` or `Partial:`. If publication succeeded but a behavior check failed, state exactly that.

## Credentials in static content

Before any remote mutation, scan the immutable staged bytes and filenames for the publishing credential — including binaries and files the host may skip, and including legacy keys without a recognizable prefix. Pattern-based redaction alone misses valid unprefixed secrets, and owner-only access does not prove a secret is absent.

Keep real values out of prompts, diffs, fixtures and logs; use obviously fake values for negative tests. If a secret did reach a published artifact, do not rewrite the historical hash receipts as though it had never happened: record the old and new digests honestly, rotate the exposed key as its own approved task, verify the replacement works, then revoke the old one. Replacing a page does not remove a credential from retained versions or caches.

## Verification matrix

| Edge | Required evidence |
|---|---|
| Intended build → staging | byte comparison or equal SHA-256 |
| Staging → publish call | success receipt tied to the staged digest |
| Publish call → released content | fresh 200 download through the public or authorized path |
| Released bytes → intended source | byte-identical comparison, full manifest coverage |
| Protected site → access boundary | policy readback plus the specified denial |
| Deployed artifact → requested behavior | runtime check through the normal authorized entry point |

## Pitfalls

- A finalize success proves the server accepted a version, not that the version contains your bytes.
- A skipped upload after a real change usually means the uploader saw the wrong path or stale bytes.
- A local preview bound to downloaded bytes is content evidence only.
- Browser cache hides stale deployments; fetch and compare before judging visually.
- Evidence does not replace the deliverable: the user wants a working link or file, with the proof behind it.

Update `mercury-verification-before-completion` before claiming the release is done, and state plainly which gates were executed versus assumed. Record durable release decisions — the publishing path, the access policy, the owning service — in the Second Brain rather than a loose note file.
