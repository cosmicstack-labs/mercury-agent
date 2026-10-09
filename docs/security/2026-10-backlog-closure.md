# Security backlog closure — October 2026 (ROADMAP P0.5)

Status: **DRAFT — nothing below has been posted.** The maintainer reviews, edits and
posts. Issue comments are ready to paste; advisory text is ready to paste into
"New draft security advisory" on GitHub.

Prepared 2026-10-09 against branch `fix/p0-hotfix-1.3.1`. All reports are by
[@YLChen-007](https://github.com/YLChen-007); the fixes are by @SeashoreShi and
@salmanqureshi. Evidence for every claim is a commit hash you can `git show`.

## 0. Two things to know before posting anything

**1. The nine identifiers in ROADMAP are not ours.** The GitHub Advisory Database
resolves every one of them to an **OpenClaw** advisory (checked 2026-10-09 via
`gh api /advisories?cve_id=…` and `/advisories/<ghsa>`):

| Identifier | Appears in Mercury issue | Actually assigned to |
|---|---|---|
| CVE-2026-22169 | #71 (find -exec) | OpenClaw — safeBins `sort` allowlist bypass (GHSA-vmqr-rc7x-3446) |
| CVE-2026-32010 | #77 (find -exec) | OpenClaw — `sort --compress-program` bypass (GHSA-4gc7-qcvf-38wg) |
| CVE-2026-30741 | #99 (delegate_task) | OpenClaw Agent Platform RCE (GHSA-rvp5-mqmc-q4g6, unreviewed) |
| CVE-2026-28463 | #95 (`$HOME` expansion, closed) | OpenClaw — safeBins shell-expansion bypass (GHSA-xvhf-x56f-2hpp) |
| CVE-2026-26322 | #81 (`github_api` token leak, closed) | OpenClaw — Gateway `gatewayUrl` override (GHSA-g6q9-8fvw-f7rf) |
| GHSA-796m-2973-wc5q | #101 (find -exec) | OpenClaw — `env -S` wrapper policy mismatch |
| GHSA-jccr-rrw2-vc8h | #76 **and** #80 (`echo $VAR`) | OpenClaw — jq `$ENV` env disclosure |
| GHSA-943q-mwmv-hhvh | #75 (delegate_task) | OpenClaw — `/tools/invoke` escalation + ACP auto-approval |
| GHSA-qrp5-gfw2-gxv4 | #98 (allowedTools bypass, closed) | OpenClaw — bundled MCP/LSP tool-policy bypass |
| — (none cited) | #72, #82 (redirection), #74 (sibling halt), #109 | — |

The reporter's PoC paths (`llm-enhance/cve-finding/similar/…/Advisory-GHSA-…-exp`)
show these were the *pattern* advisories the Mercury bugs were modelled on; the
IDs were reused as canary strings. **Do not publish Mercury advisories under these
identifiers and do not "update patched versions" on them.** Instead create new
repository advisories (GitHub assigns a fresh GHSA; tick "request CVE" if you
want one from GitHub's CNA) using the drafts in §3.

**2. Private vulnerability reporting is currently off.** `gh api
repos/cosmicstack-labs/mercury-agent/private-vulnerability-reporting` returns
`{"enabled": false}`. `SECURITY.md` points reporters at it, so enable it first:
Settings → Code security and analysis → Private vulnerability reporting → Enable.

## 1. Closure table

Release lines: v1.1.13 = `0de8955` (2026-06-18, last vulnerable for the 1.2.2
fixes). npm 1.2.1 (`63bda36`, 2026-08-05, no git tag) already carries the
`isSafeReadSegment` and sub-agent changes; the first tagged release with them is
**v1.2.2** (`e5dc012`, PR #111, 2026-08-10). v1.2.7 = `31013b0` (2026-09-14) is
the last release without the 1.3.0 fixes. v1.3.0 = `2222670` (2026-10-06).

| Issues | Class | Fixed in | Commit / PR | Regression test | Action |
|---|---|---|---|---|---|
| #71, #77, #101 (+#110 closed) | `find` action flags auto-approved | 1.2.2 (`-exec/-execdir/-ok/-okdir/-delete`); 1.3.0 (`-fprint/-fprintf/-files0-from`) | `e5dc012` (PR #111); `f465e6f`; `6a6c6bd` (#102, generic `--files0-from`) | `src/capabilities/permissions.test.ts` — "does not classify redirection or mutating read-command flags" (explicit `-exec`/`-execdir` cases added in this hotfix) and "find -fprint/-fprintf/-files0-from…" | Close all three |
| #72, #82 (+#109 closed) | Redirection turns safe reads into writes | 1.2.2 | `e5dc012` (PR #111) | `src/capabilities/permissions.test.ts` — `echo poisoned > AGENTS.md`, `echo poisoned>AGENTS.md` | Close both |
| #76, #80 (+#95 closed) | `$VAR` expansion discloses env / escapes scope | 1.3.0 | `00108b9` + `6651188` (PR #128) | `src/capabilities/permissions.test.ts` — "requires approval for safe-read commands that rely on shell expansion" (`echo $TOKEN`, `head $HOME/…`, `~`, `$'…'`) | Close both |
| #75, #99 | `delegate_task` worker ran with allow-all + `/` scope | 1.2.2 | `e5dc012` (PR #111) removed `setAutoApproveAll(true)` / `addTempScope('/')` from `SubAgent.run()` | None end-to-end yet (ROADMAP asks for one); the absence of the calls is the fix — `grep setAutoApproveAll src/core/sub-agent.ts` returns nothing | Close, with the residual race stated openly and tracked in P2.2 |
| #74 (+#97, #98 closed) | `allowedTools` not enforced; child can halt siblings | 1.3.0 (allowedTools); lineage **pending** | `0f5fe78` | `src/utils/tool-filter.test.ts` — "drops orchestration tools that are not allowlisted" | Keep open (or close and open a narrower lineage issue); post status |

Residual for #75/#99, in plain terms: sub-agents still share the parent's single
mutable `PermissionManager` (`supervisor.ts:183`). When the main loop handles an
`internal`-channel message it calls `setAutoApproveAll(true)` for the duration of
that turn (`agent.ts:2929-2933` → `:5225`). A worker whose tool call lands inside
that window is auto-approved. It needs an internal turn to be running at the same
time, so it is not reachable from chat input alone, but it is a real gap. The fix
is an immutable per-agent permission context (ROADMAP P2.2). The sub-agent system
prompt also still says "You have full permissions for this task"
(`sub-agent.ts:504`); that is prompt text only and should be reworded in P1.12.

## 2. Issue comments (ready to paste)

### #71, #77, #101 — `find -exec` (post the same text on each; adjust the "see also" line)

> Fixed — closing. Thanks @YLChen-007 for the clear report and the deterministic
> stub-provider harness; it made this easy to replay.
>
> **Fix:** `isSafeReadSegment` in `src/capabilities/permissions.ts` refuses to
> auto-approve any `find` segment carrying `-exec`, `-execdir`, `-ok`, `-okdir`
> or `-delete`; those fall through to the normal Ask Me prompt. Shipped in
> **v1.2.2** (commit `e5dc012`, PR #111). The same gate was widened in
> **v1.3.0** to `-fprint`/`-fprintf` (attacker-chosen write path) and
> `-files0-from` (path list dereferenced at exec time), plus a generic
> `--files0-from` deny for every safe-read command (`f465e6f`, `6a6c6bd`).
>
> **Verified:** your exact payload
> `find . -maxdepth 0 -exec sh -c 'printf … > canary.txt' ';'` now produces a
> permission prompt; plain `find . -maxdepth 1` stays auto-approved.
>
> **Regression tests:** `src/capabilities/permissions.test.ts` — an explicit
> `find -exec` / `-execdir` case is in 1.3.1 alongside the existing `-delete`,
> `-fprint`, `-fprintf`, `-files0-from` cases.
>
> **Affected:** ≤ 1.1.13. **Patched:** ≥ 1.2.2 (full flag set ≥ 1.3.0).
> Same root cause as #71 / #77 / #101 / #110. A GitHub advisory for this class
> is being published from this repository and will credit you.
>
> Honest caveat: the safe-read lane is a pattern check on the command string.
> It is best-effort until the argv-allowlist lane lands (ROADMAP P2.2), and
> `SECURITY.md` now says so.

### #72, #82 — shell redirection

> Fixed — closing. Thanks @YLChen-007; the control-path design in your harness
> (direct `sh -c` prompts, redirected `cat` did not) was exactly the right test.
>
> **Fix:** `isSafeReadSegment` rejects any safe-read segment containing a
> redirection operator (`>`, `>>`, `<`, `<<`, `2>`, `&>`, with or without
> spaces) before the allowlist match, so `cat README.md > variant.txt` and
> `echo X>f` go to the Ask Me prompt. Shipped in **v1.2.2** (commit `e5dc012`,
> PR #111). This is the same fix recorded on #109.
>
> **Regression tests:** `src/capabilities/permissions.test.ts` — "does not
> classify redirection or mutating read-command flags as safe reads"
> (`echo poisoned > AGENTS.md`, `echo poisoned>AGENTS.md`).
>
> **Affected:** ≤ 1.1.13. **Patched:** ≥ 1.2.2. Duplicate of #72 / #82 / #109;
> one advisory covers the class and will credit you.

### #76, #80 — `echo $VAR` environment disclosure

> Fixed — closing. Thanks @YLChen-007, and thanks @SeashoreShi for the PR.
>
> **Fix:** PR #128 (`00108b9`, follow-up `6651188`) makes `isSafeReadSegment`
> require approval for any segment that relies on shell expansion — `$VAR`,
> `${VAR}`, `$(…)`, backticks, ANSI-C `$'…'`, and `~`/`~user` — because the
> literal-path gate runs before the shell expands them. `echo $TOKEN`,
> `printenv`-style disclosure through `echo`, and `head $HOME/secret` (#95) all
> prompt now. Shipped in **v1.3.0**.
>
> **Regression tests:** `src/capabilities/permissions.test.ts` — "requires
> approval for safe-read commands that rely on shell expansion" (includes
> `echo $TOKEN` with a reference to this issue).
>
> **Affected:** ≤ 1.2.7. **Patched:** ≥ 1.3.0. Same root cause as #76 / #80 /
> #95; one advisory covers the class and will credit you.

### #75, #99 — `delegate_task` approval bypass

> Fixed — closing, with one residual noted below so it is not lost. Thanks
> @YLChen-007 for the end-to-end differential harness.
>
> **Fix:** `SubAgent.run()` no longer calls
> `permissions.setAutoApproveAll(true)` or `addTempScope('/', true, true)`.
> A delegated worker runs under the same `PermissionManager` state and channel
> context as the parent, so its `run_command` calls hit the same Ask Me prompt
> as the direct path (your control case). Shipped in **v1.2.2** (commit
> `e5dc012`, PR #111). In **v1.3.0**, `allowedTools` also became a real runtime
> filter on the tools a worker receives (`0f5fe78`, #97/#98).
>
> **Verified:** your exploit payload now yields `permissionRequestCount: 1` on
> the delegated path, matching the control.
>
> **Residual (tracked, not closed):** workers still share the parent's single
> mutable permission manager. When the main agent processes an
> `internal`-channel turn (scheduled/background work) it enables allow-all for
> that turn; a worker whose tool call lands inside that window inherits it.
> This needs a concurrent internal turn, so it is not reachable from chat
> input alone, but it is real. The fix is an immutable per-agent permission
> context (ROADMAP P2.2); an end-to-end regression test for this issue is on
> the same list. If you want to keep poking at it, that window is the place.
>
> **Affected:** ≤ 1.1.13. **Patched:** ≥ 1.2.2. One advisory covers #75 / #99
> and will credit you.

### #74 — restricted sub-agent halts siblings (status comment; keep open)

> Status update, thanks @YLChen-007. This is **partially fixed** and we are
> keeping it open for the remainder.
>
> **Fixed in v1.3.0** (`0f5fe78`, closes #97/#98): `allowedTools` is now
> enforced at runtime. A child spawned with `allowedTools: ['read_file']` is
> handed only `read_file`; it never sees `list_agents` or `stop_agent`. Test:
> `src/utils/tool-filter.test.ts` ("drops orchestration tools that are not
> allowlisted").
>
> **Still open:** (1) `stop_agent` has no ownership/lineage check —
> `supervisor.halt(agentId)` will halt any agent id, so a child spawned
> *without* an `allowedTools` list can still halt a sibling; (2) children with
> no `allowedTools` receive the orchestration tools by default. Plan (ROADMAP
> P1.12): strip `delegate_task`/`list_agents`/`stop_agent` from children unless
> explicitly allowed, and restrict `stop_agent` to the caller's own descendants,
> with a lineage test. We will update here when that lands.

## 3. Advisory drafts (new repository advisories — do not reuse the OpenClaw IDs)

Common fields: Ecosystem **npm**, package **`@cosmicstack/mercury-agent`**,
credit **@YLChen-007 (reporter)**, fix credit @SeashoreShi / @salmanqureshi.
CVSS vectors below are the reporter's; adjust if you disagree. Severity is as
reported.

### A. Safe-read auto-approval bypass via `find` action flags

- **Summary:** In Ask Me mode, Mercury auto-approved any `run_command` whose
  segments matched the read-only allowlist, including `find *`. `find`'s
  `-exec`/`-execdir`/`-ok`/`-okdir`/`-delete` (and `-fprint`/`-fprintf`/
  `-files0-from`) are side-effectful, so an authenticated chat/dashboard user
  who could steer the model into `run_command` could run an arbitrary
  subprocess or write files without the approval prompt.
- **Affected:** ≤ 1.1.13 (full flag coverage: ≤ 1.2.7).
- **Patched:** 1.2.2 (`e5dc012`); 1.3.0 (`f465e6f`, `6a6c6bd`).
- **References:** #71, #77, #101, #110, #102. CWE-285. High,
  `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`.
- **Workaround for unpatched versions:** none short of disabling the shell
  capability; upgrade.

### B. Safe-read auto-approval bypass via shell redirection

- **Summary:** Auto-approved read-only commands (`cat`, `echo`, `grep`, …)
  were executed through `shell: true` with redirection operators intact, so
  `cat README.md > out.txt` or `echo X >> file` wrote files in the workspace
  without a prompt.
- **Affected:** ≤ 1.1.13. **Patched:** 1.2.2 (`e5dc012`).
- **References:** #72, #82, #109. CWE-863 / CWE-266. High,
  `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:L` (#82; #72 gives `C:N/I:H/A:N`).

### C. Safe-read auto-approval bypass via shell expansion (env disclosure, scope escape)

- **Summary:** The safe-read check ran on the literal command string before
  the shell expanded it, so `echo $SECRET` disclosed environment variables and
  `head $HOME/…` / `cat ~/…` / `$'…'` read files outside the approved scopes
  without a prompt.
- **Affected:** ≤ 1.2.7. **Patched:** 1.3.0 (PR #128: `00108b9`, `6651188`).
- **References:** #76, #80, #95. CWE-200 / CWE-266. High
  (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`; reporter rated #80 High,
  #76 and #95 Medium on the same vector).

### D. Delegated sub-agents bypassed shell/filesystem approvals

- **Summary:** `SubAgent.run()` unconditionally enabled allow-all on the shared
  permission manager and granted a read/write temp scope at `/`, so a prompt
  routed through `delegate_task` executed `run_command` and file writes without
  the approval prompt the direct path shows.
- **Affected:** ≤ 1.1.13. **Patched:** 1.2.2 (`e5dc012`).
- **Known limitation after the patch:** workers share the parent's permission
  manager; a worker tool call that coincides with an internal-channel turn of
  the main agent (which enables allow-all for that turn) is auto-approved.
  Tracked in ROADMAP P2.2 (immutable per-agent permission context).
- **References:** #75, #99. CWE-285. High,
  `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`.

### E. Sub-agent `allowedTools` not enforced at runtime

- **Summary:** `delegate_task` accepted an `allowedTools` list but
  `SubAgent.run()` handed the model the full tool registry, so a child
  restricted to `read_file` could still call `run_command`, file-mutation
  tools, `list_agents` and `stop_agent` (and halt sibling agents).
- **Affected:** ≤ 1.2.7. **Patched:** 1.3.0 (`0f5fe78`).
- **Known limitation after the patch:** no ownership check on `stop_agent`;
  orchestration tools still exposed to children that set no `allowedTools`
  (ROADMAP P1.12).
- **References:** #74, #97, #98. CWE-285. Reporter rated #74 Medium
  (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:H/A:H`) but #97/#98 High
  (`AV:N … C:H/I:H/A:H`); High is the defensible choice for the class because
  it exposed `run_command` and file mutation, not only sibling halts.

### F. `github_api` forwarded `GITHUB_TOKEN` to attacker-chosen hosts

- **Summary:** `githubRequest()` treated any `path` beginning with `http` as a
  full URL and still attached the bearer token, so a model-driven
  `github_api` call could send the host's GitHub token to an arbitrary server.
- **Affected:** ≤ 1.2.7. **Patched:** 1.3.0 (`cc5b879` PR #129 confines
  requests to `api.github.com`; `71a662f` PR #130 requires https).
- **References:** #81 (closed 2026-09-22). CWE-918 / CWE-200. High,
  `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N`.
- The reporter referenced CVE-2026-26322, which is OpenClaw's; request a new
  CVE if wanted.

### Also eligible for advisories (no identifier was cited by the reporter)

| Issue | Class | Patched | Commit |
|---|---|---|---|
| #105 | Writes followed in-scope symlinks outside approved scopes | 1.3.0 | `757cdd8` |
| #73 | `/bg <command>` skipped `checkShellCommand` | 1.3.0 | `efb8a45` |
| #100 | Telegram members could reach `install_skill` → shell | 1.3.0 | `8160bff` |
| #106 | Skill names could escape the skills root | 1.3.0 | `8806b29` |
| #107, #108 | `fetch_url` SSRF | 1.2.3 (guard), 1.3.0 (`599450a` #121, `337e0a7` #124) | see `ssrf-108-response.md` |

## 4. Still open after this pass (not "fixed-but-open")

- #103 — auto-approved helpers resolve executables from a mutable `PATH`
  (ROADMAP P2.2 PATH pinning + argv lane).
- #104 — hardlink alias read bypass (ROADMAP P1.12 `nlink>1` prompt).

## 5. Checklist for the maintainer

1. Enable private vulnerability reporting (see §0.2).
2. Merge/release 1.3.1 so the `find -exec` test and the git-helper fix are on a tag.
3. Post the §2 comments; close #71 #77 #101 #72 #82 #76 #80 #75 #99; leave #74 open.
4. Create advisories A–F from §3 (GitHub assigns GHSA IDs; optionally request CVEs);
   add the issue links as references and credit @YLChen-007. Do not touch the
   OpenClaw advisories.
5. Optionally reply on #81, #95, #97, #98, #102, #105, #109, #110 pointing at the
   published advisory so the reporter can update their own records.
