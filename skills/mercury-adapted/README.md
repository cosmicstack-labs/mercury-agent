# Mercury adapted skills

Forty opt-in instruction skills: curated Mercury adaptations alongside
independently written native workflows. They use Mercury tools, not Hermes APIs.
Per-skill origin is recorded in each skill's `author` and `attribution` frontmatter;
`LICENSE` lists the credited upstream sources, so no count here can drift out of date.
`src/skills/hermes-adapted.test.ts` checks discovery, metadata, safety contracts
and isolated install/reload. Shipping this pack does not install it into a profile.

## Locate the pack

From a Git checkout: `pack="$PWD/skills/mercury-adapted"`.
For global npm: `pack="$(npm root -g)/@cosmicstack/mercury-agent/skills/mercury-adapted"`.
For local npm use `npm root` and `npx --no-install mercury` for the CLI.
Check that the pack README exists; older releases may not include this pack.
On Windows use absolute paths; these shell examples are POSIX, not PowerShell.

Standalone/Desktop releases containing the pack provide a companion
`mercury-adapted-skills.tgz` and `checksums.txt`. Obtain both from the same trusted
release, verify SHA-256, and extract into a new directory. The archive root is
`mercury-adapted/`; set `pack` to that extracted directory. Checksums establish
byte identity, not publisher trust. Keep the README and LICENSE with source copies.

## Install and verify

Review first, then use the official installer:

```sh
mercury skills install --from "$pack/rss-feeds/SKILL.md" -y
```

For the entire reviewed and approved pack:

```sh
(
  for file in "$pack"/*/SKILL.md; do
    mercury skills install --from "$file" -y || exit 1
  done
) && mercury skills list && mercury skills doctor
```

The installer derives category/slug from frontmatter, records source paths and
maintains the index. Keep local sources at a stable location. These are local
`--from` installs, not registry subscriptions; reinstall reviewed files to update.
`mercury skills update` is registry-oriented. Installation normally targets
`~/.mercury/skills`, or `$MERCURY_HOME/skills` if overridden.

A fresh profile should list exactly 40 pack skills; an existing profile may have
more. Doctor checks index health and registry reachability, so registry outages
do not establish local installation failure. `mercury skills view <category/slug>
--raw` reads installed content. Invoke names use the `mercury-` prefix, e.g.
`#mercury-grounded-citations`, independently of their directory names.

`node scripts/verify-package.cjs` builds and installs the npm tarball, then uses
its CLI in a temporary Mercury home to install all 40 skills and compare loaded
bytes with source. It also validates and installs the two optional plugins in
that temporary profile; it does not change your live profile.

## Expansion scope

The first expansion added review reception, Git worktrees and branch completion.
The next adds transactional recovery, judge-output contracts and financial estimate
refutation. Six new native workflows cover shell-wrapper reliability, reproducible
ZIP builds, MCP-server development, image/PDF production, collision-safe file
organization and backup/restore verification. The latter six do not bundle or copy
unresolved-license upstream text, scripts or assets. Acceptance-test integrity is
merged into verification-before-completion rather than creating a duplicate skill.

The third expansion adds spike-driven feasibility work, blocked-page recovery,
static-artifact release verification, local file retrieval, automation right-sizing
and subagent delegation. These are independent Mercury rewrites: no
upstream script, reference payload or asset is bundled, and the blocked-page ladder
is described as bounded manual routes rather than a bundled recovery tool. The
evaluator-optimizer revision gate was merged into the existing review reception and
verification workflows instead of adding a near-duplicate.

The fourth addition is `video-editing`, a native FFmpeg procedure for cutting,
cropping, captioning, loudness-matching and exporting local footage. It is an
independent rewrite, not a port of the noncommercial `hermes-video-editor` plugin:
no upstream tool, preset or script is bundled, and it drives only the host's own
`ffmpeg` and `ffprobe`. Its key commands were executed against a generated test clip
before shipping, which is where the measured figures in it (keyframe snapping,
full-decode exit status, loudness offsets) come from.

Inventory triage covered 347 active source cards, with 46 archived cards excluded.
This is not a claim that all source workflows have been implemented or audited in
depth: specialist workflows, duplicate tool wrappers, platform-specific integrations
and file-backed memory architectures remain deferred. Generic deferral is not a
security verdict. The plugin inventory contains 24 logical candidates: 22 with a
`plugin.yaml` manifest (23 manifest files, since `model-providers` ships two) and two
with a JSON manifest. No additional runtime plugin is enabled by this
expansion; external services, incompatible hooks and unresolved licensing require
separate integration review and approval.

## Optional plugins

`live-time` provides an on-demand clock, not automatic context injection.
`hardlight` provides contrast and declared navigation-graph checks, not full
upstream parity or rendered UI certification. See their READMEs. Neither is required
for skill discovery, and installing skills never silently enables a plugin.

### Why no further plugin is ported

The source inventory holds 24 logical plugin candidates: 22 directories with a
`plugin.yaml` (23 manifest files, because `model-providers` ships two) and two with
a JSON manifest (`parallel-search`, `rea`). Each candidate was checked for licence
file, declared hooks, credentials and overlap. All 24 are accounted for below; a
candidate can fail more than one gate.

Four gates decide it:

1. **No hook API in Mercury.** Mercury's plugin contract contributes only `tools`,
   `commands` and `channel`; there is no `provides_hooks` equivalent. Eight
   candidates declare hooks (`barehands-ring`, `camofox`, `jev-gate`, `live-time`,
   `prompt-optimizer`, `reaction-feedback`, `rudr9-guard`, `tinyfish`). Their core
   behaviour is a call hook, not a tool.
2. **Missing licence file.** Ten ship no licence file, so their text cannot be
   redistributed here: `barehands-ring`, `better-session-appearance`, `jev-gate`,
   `markdown-new`, `model-providers`, `prompt-enhance`, `reaction-feedback`,
   `rss-reader`, `rudr9-guard`, `tmg-agentic-engineering`.
3. **Licence incompatible with this MIT repository.** `hermes-video-editor` is
   PolyForm-Noncommercial-1.0.0, so its ~9k lines of FFmpeg tooling cannot be
   bundled into an MIT repo even though it needs no key and declares no hooks. The
   `video-editing` skill covers that capability as an independent rewrite instead, so
   this is a replaced candidate rather than a lost one.
4. **Credentials or unexposed internals.** `homeassistant` (`HASS_TOKEN`), `spotify`
   (developer client id), `openmail` (`OPENMAIL_API_KEY`) and `tinyfish`
   (`TINYFISH_API_KEY`) each need an external account, so they cannot be exercised
   without one. `camofox` needs a running server. `claude-subscription-directsdk-experimental`
   drives auth tokens. `model-providers` and `advanced-delegation` hook into provider
   and delegation routing that Mercury does not expose.

Two are already covered by native rewrites: `live-time` and `hardlight` provide the
`live-time` and `hardlight-ui` capability as on-demand tools, because point 1 means
neither could inject context on every call the way its Hermes original did.
`markdown-new` and `rss-reader` would also be duplicates of `web-search` and
`rss-feeds`. `prompt-enhancer` and `better-session-appearance` are Desktop composer
and session-chrome features, not tools.

Two are configuration rather than code: `parallel-search` is a remote MCP endpoint
and `rea` runs `npx -y rea-agents`. Both need an owner's explicit approval.
`parallel-search` only duplicates the built-in `web_search` and `fetch_url` while
sending every query to a third party, so it is not worth enabling. `rea` adds real
capability but needs a reverse-engineering use case and executes third-party code on
start. Nothing here enables either.


## Provenance and limitations

See [LICENSE](./LICENSE) and individual metadata. Existing adaptations credit
MIT-labelled Hermes Agent, obra/superpowers and other named source authors;
adaptations are not upstream-endorsed. Unverified case studies and reference
payloads are not bundled. Independent native workflows are attributed to Cosmic
Stack. Registry admission and release publishing are separate maintainer decisions;
do not present adapted material as original where registry rules prohibit it.

These are curated instructions, not self-made procedures verified end to end.
They do not execute installs or change settings by themselves. Approval gates in
prose are procedural guidance, not runtime enforcement. Passing content/package
tests establishes parsing, installation and loader contracts, not success of every
operational workflow. Live provider, restore, device and external-service behavior
requires separately authorized representative execution.
