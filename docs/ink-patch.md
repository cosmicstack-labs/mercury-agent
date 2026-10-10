# Mercury's ink patch set

Mercury renders its TUI with [ink](https://github.com/vadimdemedes/ink) 8.0.0 and carries four changes to it. Since ADR-017 the patched build is vendored in `vendor/ink/` and bundled into `dist/index.js`, so no install step has to apply them. This page describes each hunk, why it exists, and what an upstream version could look like.

| Item | Where |
|---|---|
| Single source of truth for the hunks | `scripts/apply-ink-patch.cjs` |
| Regenerate `vendor/ink` (stock tarball + hunks) | `node scripts/vendor-ink.cjs` |
| Prove the committed files are exactly tarball + hunks | `node scripts/vendor-ink.cjs --check` (runs in CI) |
| Reviewable stock-vs-vendored diff | `patches/ink+8.0.0.patch` (generated) |
| Runtime detection / `mercury doctor` | `src/ui/ink-patch-check.ts` |
| Bundler and test wiring | `tsup.config.ts` (alias + `noExternal`), `vitest.config.ts`, `tsconfig.json` `paths` |

`vendor/ink` holds only what the runtime needs: `build/` without source maps (and without the `sourceMappingURL` trailers that pointed at them), a `package.json` with ink's development-only fields removed, and the MIT `license`. The stock tarball is verified against its registry `sha512` before anything is copied.

Every hunk anchors on exact ink 8.0.0 source text. If an anchor is missing or ambiguous, the applier fails and names the hunk instead of skipping it. Each hunk leaves a marker, so `isPatched()` and the runtime check can confirm it was applied.

---

## 1. `<Static itemKey>` (`components/Static.js`, `Static.d.ts`)

**Problem.** `<Static>` decides which items are new with a positional index (`items.slice(index)`), which assumes `items` only ever grows. Mercury keeps the transcript bounded by sliding a window (the newest 100 messages). Once the window starts dropping old items, the index points past the end, new messages never render, and every commit unmounts the whole static subtree.

**Fix.** An optional `itemKey(item) => string | undefined` prop. When it is set, `<Static>` tracks the keys it has already written and renders only unseen items, so each item is printed exactly once per instance even when the window slides. After writing, it bumps a `commitTick` so the written children unmount; otherwise they stay mounted and are re-emitted as static output on every later frame. The positional path is unchanged when `itemKey` is absent.

**Upstream.** Still needed on ink 8, whose `<Static>` is positional. Additive, opt-in API: the prop plus the `commitTick` unmount, with a test that slides a bounded window. The best candidate to propose.

## 2. Freeze gate (`ink.js`)

**Problem.** Mercury's scroll lock (Ctrl+S, `/mc freeze`) lets users scroll and copy from native scrollback while output keeps arriving. Any frame ink writes during that time moves the viewport. Skipping frames is not enough on its own: if `lastOutput` or log-update's baseline advances, the first frame after resume diffs against rows that were never drawn and erases the wrong lines.

**Fix.** `export const frameGate = { frozen, armed, marker }`, also exposed as `globalThis.__mercuryFrameGate`. While `frozen` is set, `onRender` returns right after `render()`, before `renderFrame()` writes anything or touches a baseline. `armed` + `marker` let exactly one frame through, the one that contains the "⏸ frozen" hint.

**Upstream.** Ink 7.1's `suspendTerminal()` hands the terminal to a child process, which is close but not the same. A public `instance.pause()` / `instance.resume()` with the same no-baseline-advance guarantee would replace this.

## 3. Live-region guard (`ink.js`)

**Problem.** When the live frame is as tall as the terminal or taller, ink writes the whole frame. On the primary screen every row past the viewport scrolls into scrollback, so each repaint while a reply streams stamps another copy of the top of the live region into the user's history. (Ink 5 was worse: it cleared the scrollback and re-dumped every static byte. Ink 8 fixed that half.)

**Fix.** On an interactive TTY, outside the alternate screen and screen-reader mode, a frame of `rows` or more is trimmed to its newest `rows - 1` rows before `renderFrame()`, anchored at the bottom so the input and status bar stay visible. The trimmed rows are never written, so they cannot reach scrollback. `src/ui/live-region-guard.test.tsx` fails if this hunk is removed.

**Upstream.** A behaviour option such as `overflow: 'trim-top' | 'write'`, defaulting to today's behaviour.

## 4. Cursor anchor (`ink.js`) — #41, #66

**Problem.** Input methods (Chinese, Japanese and Korean IMEs, the macOS accent picker, dictation) open their preedit text and candidate window at the hardware cursor. Ink 8 can place the real cursor (`useCursor()` → `setCursorPosition({ x, y })`), but the caller must supply the coordinates, and React has no cheap way to know where an inline cell lands after layout.

**Fix.** Mercury's `CursorCell` marks its element with an `internal_cursor` attribute. After `render()` (and after the live-region trim), `onRender` walks the laid-out live tree, sums Yoga offsets to the marked element exactly as the renderer does, and hands `{ x, y }` to ink's own `setCursorPosition`, so ink's log-update shows the cursor there and hides it before the next write. Only a change is pushed, because a dirty cursor forces ink to rewrite an otherwise unchanged frame. No marked element (a prompt or a non-input pane owns the keyboard) means `undefined`: the cursor stays hidden. `cursorAnchor.enabled = false` (`MERCURY_HW_CURSOR=0`) turns it off.

The attribute is read from ink's DOM node rather than a ref because React attaches refs in the layout phase, after the frame has already been rendered, so a ref-based anchor would always be one frame late. Nothing is inserted into the frame text.

**Upstream.** A layout-aware variant of `useCursor()` — for example `useCursor({ anchor: ref })` resolved inside ink after layout — would replace this hunk.

---

## Retired with the move to ink 8

These hunks existed on ink 5.2.1 and are now upstream behaviour, so the vendored build no longer carries them:

| Former hunk | Replaced by (ink 8) |
|---|---|
| Yoga free-node hygiene | `freeYogaSubtree` nulls freed Yoga references; `clearStaticNodeIfContained` clears the cached static node |
| Diff-render | `incrementalRendering: true` (set in `CLIChannel.mountTUI`) |
| Resize baseline invalidate | ink 8's `resized()` and viewport handling; after shed writes Mercury calls `instance.clear()` so the next frame is a full repaint |
| Hand-rolled cursor park/unpark | log-update's cursor support, fed by hunk 4 |
| Synchronized output (DEC 2026) | built in since ink 6.7 |

## Upgrading ink

1. Bump `INK_VERSION` and `INK_INTEGRITY` in `scripts/vendor-ink.cjs`. The integrity value is `dist.integrity` from `npm view ink@<v> dist.integrity`. Bump the `ink` devDependency to the same exact version.
2. Run `node scripts/vendor-ink.cjs`. A hunk whose anchor moved fails with a named error; re-anchor it in `scripts/apply-ink-patch.cjs`, and check the release notes for hunks that upstream now covers.
3. Review `patches/ink+<v>.patch`, then run `npx vitest run src/ui src/channels scripts/apply-ink-patch.test.ts` and `npm run build && node dist/index.js --help`.
