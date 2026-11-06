# Hardlight Local Checks for Mercury

An independently packaged JavaScript adaptation of two stateless tools from Hardlight UI. Source reference: the installed Hermes Hardlight UI `hardlight/contrast.py` and `hardlight/navigation.py`, MIT, copyright 2026 Seth Wilson and Hardlight UI contributors. This is **not** the complete Hardlight UI plugin or a Hermes compatibility layer.

## Tools

- `hardlight__contrast`: opaque #RGB/#RRGGBB sRGB contrast for explicit `text`, `large_text`, or `ui` roles. Compares the unrounded ratio to 4.5, 3, or 3 respectively. At most 100 pairs. No alpha/composites. Optional labels: at most 500 characters.
- `hardlight__navigation`: shortest task paths in a declared directed graph; missing destinations, ambiguous labels, unreachable pages and non-goal dead ends. At most 300 pages, 100 tasks, 1,000 links/page and 10,000 total links. IDs: at most 200 characters; labels/names: at most 500; no control characters. Optional integer `max_steps`: 0..1,000,000. No universal click budget is invented. Input order breaks shortest-path ties. Default home is the first page.

Both tools validate input and return `{ok: false, error}` atomically on unsupported inputs. Success returns coverage and limitations. Navigation accepts IDs such as `__proto__` safely using Map/Set. Unknown links are reported but excluded from reachability.

## Permissions and status

No imports, network, secrets, file reads/writes, subprocesses or timers. The entry only registers two read-only tools through Mercury's SDK. In-process plugins are trusted JavaScript, not an OS sandbox; these statements describe this implementation, not a general security boundary.

The source package is not automatically installed or enabled. Testing starts/stops it only in the conformance harness; deployment requires separate approval. From a Mercury checkout, run:

```sh
./node_modules/.bin/vitest run src/plugins/hardlight.test.ts
```

Use Mercury's plugin manager to validate/install the folder only after approval. Requires Mercury >=1.5.1 <2 and plugin API ^1.0.0. It has no package dependencies or build step.

## Examples (tool argument objects)

Contrast:

```json
{"pairs":[{"foreground":"#111","background":"#fff","role":"text","label":"body"}]}
```

Navigation:

```json
{"pages":[{"id":"home","label":"Home","links":[{"to":"detail","label":"Open detail"}]},{"id":"detail","label":"Detail","links":[{"to":"home","label":"Back home"}]}],"tasks":[{"name":"Open detail","start":"home","goal":"detail","max_steps":2}],"home":"home"}
```

## Limits

Contrast results do not certify WCAG conformance. Graph results do not prove rendered navigation, keyboard access, permissions, browser history, task success or usability. This adaptation does not include Hardlight's reference library, direction generation, filesystem inspection or browser runner. The companion `mercury-frontend-design` skill works without this optional plugin and requires actual rendered evidence for visual claims.
