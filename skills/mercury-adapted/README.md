# Mercury adapted skills

Twenty-one skills adapted for Mercury from MIT-labelled Hermes Agent and
`obra/superpowers` sources. They use Mercury's own tools (`delegate_task`,
`schedule_task`, the Second Brain, `search_memory`), not Hermes-only APIs.
`src/skills/hermes-adapted.test.ts` checks discovery, metadata and key contracts.

The pack is opt-in. Shipping these files does **not** install them into your
profile: Mercury loads installed skills from its skills directory (normally
`~/.mercury/skills`, or `$MERCURY_HOME/skills` when overridden).

## Locate the pack

Choose the distribution you have. The examples below use a POSIX shell.

### Git checkout

From the repository root:

```sh
pack="$PWD/skills/mercury-adapted"
```

### npm installation

For a global installation of a version containing this pack:

```sh
pack="$(npm root -g)/@cosmicstack/mercury-agent/skills/mercury-adapted"
```

For a local installation, use `$(npm root)/@cosmicstack/mercury-agent/skills/mercury-adapted`
and invoke the local CLI with `npx --no-install mercury`. On Windows, locate the
same directory with `npm root -g` or `npm root` and pass absolute paths to the
commands below; the shell loop is not PowerShell syntax.

Older published packages may not contain the pack. Check that
`"$pack/README.md"` exists; a successful installation of Mercury alone does not
prove the pack shipped. The package version is assigned by the normal release
process, not by these instructions.

### Standalone Mercury / Mercury Desktop runtime

The skills are not embedded in the executable. Releases containing this pack
provide a companion `mercury-adapted-skills.tgz` and `checksums.txt`. Download
both from the **same trusted release**, verify the archive's SHA-256 against
that release's checksums, and extract into a new directory. The archive has a
`mercury-adapted/` root:

```sh
mkdir mercury-skill-pack
tar -xzf mercury-adapted-skills.tgz -C mercury-skill-pack
pack="$PWD/mercury-skill-pack/mercury-adapted"
```

Checksums detect mismatched bytes, not whether a publisher is trustworthy.
Keep the accompanying README and LICENSE with the archive/source copies.

## Install and verify

Review the skill before installing it. Use the official installer:

```sh
mercury skills install --from "$pack/rss-feeds/SKILL.md" -y
```

To install all 21 after reviewing the pack:

```sh
(
  for file in "$pack"/*/SKILL.md; do
    mercury skills install --from "$file" -y || exit 1
  done
) && mercury skills list && mercury skills doctor
```

The installer records the source path, derives the category/slug from
frontmatter and maintains the index. Keep the pack at a stable location if you
want the recorded local source path to remain useful. These are local `--from`
installs, **not registry subscriptions**: reinstall reviewed files to update;
`mercury skills update` is registry-oriented.

A fresh profile should list exactly 21 skills after installing the whole pack.
An existing profile may list more. Doctor checks both local index health and
registry reachability; a registry outage is not proof of a local install
failure. For an individual installed skill, `mercury skills view <category/slug>
--raw` reads its installed content.

The release gate `node scripts/verify-package.cjs` builds and installs the npm
tarball, then uses that installed CLI in a fresh temporary Mercury home to
install all 21 and compare their reloaded bytes with source. It also validates
and installs the two optional plugins. This does not modify your profile.

## Naming

The directory name and frontmatter `name` differ on purpose. For example,
`grounded-citations/` is invoked as `#mercury-grounded-citations`. The `mercury-`
prefix avoids collisions with same-named registry skills; tests check the
mapping.

## Optional plugins

The pack does not require either plugin to load. `live-time` supplies an
on-demand clock tool; `hardlight` supplies explicit contrast and declared
navigation-graph checks, not a rendered UI audit. See their shipped READMEs
for validation, installation and limitations. No plugin is silently enabled by
installing these skills.

## Provenance and licence

See [LICENSE](./LICENSE) and each skill's metadata. Adaptations are not
upstream-endorsed and do not claim full compatibility with their originals.
Unverified upstream case studies and reference files are not bundled. Do not
submit this pack as original work to a registry that requires original content;
any registry admission is a separate maintainer decision.

## Scope

These files are instructions the agent reads. They do not execute, install or
change settings on their own. Some describe approval gates not enforced by
runtime code: those are procedural guidance, not security guarantees. Passing
package and content tests proves parse/install contracts, not that every
workflow will succeed for arbitrary inputs.
