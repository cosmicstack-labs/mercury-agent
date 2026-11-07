# Mercury adapted skills

Thirty-nine opt-in instruction skills: curated Mercury adaptations and twelve
independently written native workflows. They use Mercury tools, not Hermes APIs.
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

A fresh profile should list exactly 39 pack skills; an existing profile may have
more. Doctor checks index health and registry reachability, so registry outages
do not establish local installation failure. `mercury skills view <category/slug>
--raw` reads installed content. Invoke names use the `mercury-` prefix, e.g.
`#mercury-grounded-citations`, independently of their directory names.

`node scripts/verify-package.cjs` builds and installs the npm tarball, then uses
its CLI in a temporary Mercury home to install all 39 skills and compare loaded
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

Inventory triage covered 347 active source cards, with 46 archived cards excluded.
This is not a claim that all source workflows have been implemented or audited in
depth: specialist workflows, duplicate tool wrappers, platform-specific integrations
and file-backed memory architectures remain deferred. Generic deferral is not a
security verdict. The plugin inventory contains 25 logical candidates: 23 YAML
manifests and two JSON packages. No additional runtime plugin is enabled by this
expansion; external services, incompatible hooks and unresolved licensing require
separate integration review and approval.

## Optional plugins

`live-time` provides an on-demand clock, not automatic context injection.
`hardlight` provides contrast and declared navigation-graph checks, not full
upstream parity or rendered UI certification. See their READMEs. Neither is required
for skill discovery, and installing skills never silently enables a plugin.

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
