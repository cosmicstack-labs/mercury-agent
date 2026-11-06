# Mercury adapted skills

Twenty-one skills adapted for Mercury from MIT-labelled Hermes Agent and
`obra/superpowers` sources. They are written against Mercury's own tools
(`delegate_task`, `schedule_task`, the Second Brain, `search_memory`) and use no
Hermes-only syntax — no `skill_view`, `skill_manage`, `terminal`, `web_extract`
or `~/.hermes` paths. `src/skills/hermes-adapted.test.ts` enforces that.

This directory is the source of truth. It is not read at runtime: Mercury loads
skills from `~/.mercury/skills`, so the pack has to be installed.

## Installing

Use the bundled installer, one skill at a time:

```sh
mercury skills install --from skills/mercury-adapted/rss-feeds/SKILL.md -y
```

The installer derives the category from the skill's frontmatter and writes
`~/.mercury/skills/<category>/<slug>/SKILL.md` plus its index entry. To install
everything:

```sh
for d in skills/mercury-adapted/*/; do
  n=$(basename "$d")
  mercury skills install --from "skills/mercury-adapted/$n/SKILL.md" -y
done
```

Then confirm with `mercury skills doctor` (expect `Installed: 21`, index `[ok]`).

Pass an explicit `.../$n/SKILL.md` path as above. Globbing to `"$d/SKILL.md"`
leaves a `//` in the recorded `file:` provenance.

## Naming

The directory name and the frontmatter `name` differ on purpose:

| Directory | Invoked as |
|---|---|
| `grounded-citations/` | `#mercury-grounded-citations` |

The `mercury-` prefix keeps these from colliding with same-named skills
installed from the registry. The test asserts the mapping in both directions.

## Provenance and licence

See [LICENSE](./LICENSE). Adaptations are rewritten for Mercury and are neither
upstream-endorsed nor a claim of full compatibility with the originals.
Per-skill origin is in each `SKILL.md`'s `author` field and in the licence
header.

Upstream case studies and `references/*.md` were dropped where they were not
verified against Mercury's behaviour; each adaptation notes that in its
attribution line.

## Scope

These files are documentation the agent reads. They do not execute, install, or
change settings on their own, and several describe approval gates that Mercury
does not yet enforce in code — the gate is in the instructions, so read them as
procedural guidance rather than runtime guarantees.
