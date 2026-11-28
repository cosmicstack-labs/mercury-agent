# Mercury native workflow pack

Nine opt-in instruction skills for local files, media, data and development:

- `shell-wrapper-reliability`
- `deterministic-release-zip-builder`
- `mcp-server-patterns`
- `image-pdf-production`
- `file-organization`
- `agent-workstation-backup-recovery`
- `video-editing`
- `tabular-data-processing`
- `document-text-extraction`

These workflows are authored for Mercury under the repository's [MIT license](./LICENSE).
They use Mercury tool names and its Second Brain conventions. They bundle no
third-party scripts, models, assets, binaries or plugins. The existing
`mercury-adapted` directory and `mercury-` skill names are retained for stable paths;
third-party adaptations are not included in this revision.

## Permissions and limits

Every skill declares `allowed-tools: []`. In Mercury, nonempty `allowed-tools`
metadata can elevate an interactive session's shell or filesystem permissions.
This pack intentionally grants none: loading instructions is not permission to run
their commands. Normal configured permissions and approval checks still apply.
Existing permissions, including an owner's Allow All setting or grants from other
skills, are not revoked by loading this pack. Prose approval instructions are not a
sandbox and cannot replace runtime enforcement.

The pack is not installed into profiles automatically. It does not install local
utilities, enable services or upload files. Missing tools are reported as blockers.
Passing content and package tests establishes discovery, no elevation on invocation,
installation and byte identity, not successful end-to-end use of every workflow.
Media, OCR, restore and external-provider behavior need representative validation.

## Locate, review and install

From a Git checkout:

```sh
pack="$PWD/skills/mercury-adapted"
```

For a global npm installation that contains this pack:

```sh
pack="$(npm root -g)/@cosmicstack/mercury-agent/skills/mercury-adapted"
```

For local npm, use `npm root` and `npx --no-install mercury` for the CLI. These are
POSIX examples; use absolute paths appropriate to your shell on Windows. Older
packages may not contain the pack. Standalone/Desktop companion archives are not
part of this change; use a reviewed Git checkout or npm package.

Read the selected `SKILL.md` and the license, then install that file:

```sh
mercury skills install --from "$pack/file-organization/SKILL.md"
mercury skills list
```

Repeat only for workflows you want. The installer derives category/slug from the
frontmatter and records the source path. Keep source files at a stable location.
Local `--from` installs are not registry subscriptions; reinstall reviewed files to
update. Installation normally targets `~/.mercury/skills` or `$MERCURY_HOME/skills`.
Invoke the installed name, for example `#mercury-file-organization`.

## Upgrading from earlier branch revisions

Reinstall the nine retained workflows to replace their earlier permission-granting
metadata. Restart affected sessions so an older skill's elevation cannot persist.
Removing a source file from this repository does not uninstall it from your profile:
use `mercury skills list`, inspect the installed IDs, and remove earlier adaptations
only if you choose to. Review or disable any previously installed optional plugins
separately. No migration silently deletes an owner's installed content.

## Verification and scope

`src/skills/native-pack.test.ts` verifies exact inventory, metadata, references,
no permission-elevation call during invocation, and isolated byte-identical reload.
`node scripts/verify-package.cjs` builds a real npm tarball, installs it into a
throwaway project and Mercury home, and verifies all nine installed skills through
the packaged CLI. It does not use the owner's profile or install plugins.

Third-party adaptations require exact source revisions, original license notices
and a separate provenance review before redistribution. Optional plugins and
standalone release changes also require their own review. This pack makes no claim
of parity with another agent or acceptance into a skills registry.
