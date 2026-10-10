# Mercury's ink patch set

Mercury renders its TUI with [ink](https://github.com/vadimdemedes/ink) 5.2.1 and carries seven fixes to it. Since ADR-017 the patched build is vendored in `vendor/ink/` and bundled into `dist/index.js`, so no install step has to apply them. This page describes each hunk, why it exists, and what an upstream version could look like.

| Item | Where |
|---|---|
| Single source of truth for the hunks | `scripts/apply-ink-patch.cjs` |
| Regenerate `vendor/ink` (stock tarball + hunks) | `node scripts/vendor-ink.cjs` |
| Prove the committed files are exactly tarball + hunks | `node scripts/vendor-ink.cjs --check` (runs in CI) |
| Reviewable stock-vs-vendored diff | `patches/ink+5.2.1.patch` (generated) |
| Runtime detection / `mercury doctor` | `src/ui/ink-patch-check.ts` |
| Bundler and test wiring | `tsup.config.ts` (alias + `noExternal`), `vitest.config.ts`, `tsconfig.json` `paths` |

`vendor/ink` holds only what the runtime needs: `build/` without source maps (and without the `sourceMappingURL` trailers that pointed at them), a `package.json` with ink's development-only fields removed, and the MIT `license`. The stock tarball is verified against its registry `sha512` before anything is copied.

Every hunk is idempotent and anchors on exact ink 5.2.1 source text. If an anchor is missing, the applier fails loudly instead of skipping the hunk. Each hunk also leaves a marker, so `isPatched()` and the runtime check can confirm it was applied.

---

## 1. Yoga free-node hygiene (`reconciler.js`)

**Problem.** When React removes a subtree, ink calls `yogaNode.freeRecursive()`, which releases the Yoga WASM memory. The JavaScript DOM nodes still keep their `yogaNode` references to that freed memory. Later layout or render passes can still reach those nodes: through the root's cached `staticNode`, through the parent climb in `measure`, or through an in-flight throttled render. Reading a freed node traps inside WASM with `RuntimeError: memory access out of bounds` in `getComputedWidth`, which crashes the process. Long Mercury sessions hit this regularly.

**Fix.** Removals now go through `cleanupRemovedNode`:

- Free the Yoga subtree as before.
- Walk the removed DOM subtree and set every `yogaNode` to `undefined`. The walk skips `#text` nodes, which have no `childNodes`.
- If the removed subtree contains the root's cached `staticNode`, clear that cache too. `removeChild` receives the direct parent, so the hunk climbs to the root before checking.

The renderer already reads `yogaNode` through optional chaining, so a cleared reference becomes a no-op instead of a crash. The hunk sets `globalThis.__mercuryInkYogaHygiene = true` so the bundled build can be checked without reading files.

**Upstream.** This is a pure bug fix with no API change. It matches the analysis in [facebook/yoga#1818](https://github.com/facebook/yoga/issues/1818), and qwen-code#7816 applies the same fix downstream. It is the strongest candidate to propose first.

## 2. `<Static itemKey>` (`components/Static.js`, `Static.d.ts`)

**Problem.** `<Static>` decides which items are new with a positional index (`items.slice(index)`), which assumes `items` only ever grows. Mercury keeps the transcript bounded by sliding a window (the newest 100 messages). Once the window starts dropping old items, the index points past the end, new messages never render, and every commit unmounts the whole static subtree, churning freed Yoga nodes and feeding hunk 1's crash.

**Fix.** Add an optional `itemKey(item) => string | undefined` prop. When it is set, `<Static>` tracks the keys it has already written and renders only unseen items, so each item is printed exactly once per instance even when the window slides. After writing, it bumps a `commitTick` so the written children unmount. Without that bump, ink's renderer re-prints still-mounted static children on every later frame, which duplicates transcript lines. The positional path is unchanged when `itemKey` is absent.

**Upstream.** Additive, opt-in API. The proposal is the prop plus the `commitTick` unmount, with a test that slides a bounded window.

## 3. Freeze gate (`ink.js`)

**Problem.** Mercury's scroll lock (Ctrl+S, `/mc freeze`) lets users scroll and copy from native scrollback while output keeps arriving. Any frame ink writes during that time moves the viewport. Simply skipping frames is not enough: if `lastOutput` or log-update's baseline advances, the first frame after resume diffs against rows that were never drawn and erases the wrong lines.

**Fix.** `export const frameGate = { frozen, armed, marker }`, also exposed as `globalThis.__mercuryFrameGate`. While `frozen` is set, `onRender` returns before writing anything or touching either baseline. `armed` + `marker` let exactly one frame through, the one that contains the "⏸ frozen" hint.

**Upstream.** Probably better as a public instance API, `instance.pause()` / `instance.resume()`, with the same no-baseline-advance guarantee than as a global. Medium priority.

## 4. Live-region guard (`ink.js`)

**Problem.** When the live frame is as tall as the terminal or taller, stock ink falls back to `clearTerminal + fullStaticOutput + output`. That wipes the whole scrollback (`ESC[3J`) and re-prints every static byte ever written, on every frame. With a long transcript that is megabytes per frame: the scrollbar jumps to the top, the UI flickers, and native scrolling stops working.

**Fix.** Trim the frame to the newest `rows - 1` rows, anchored at the bottom so the input and status bar stay visible, and send it through the normal diff path. Scrollback is never cleared and the transcript is never re-dumped.

**Upstream.** A behaviour change. It could ship as an option such as `overflow: 'trim-top' | 'clear'`, with the current behaviour as the default. The full-scrollback wipe is arguably always wrong for apps that use `<Static>`.

## 5. Diff-render (`log-update.js`)

**Problem.** Ink 5's log-update erases and rewrites the entire live region on every change. A spinner tick or a selection change in a prompt repaints every row, which shows up as a full-UI flash, especially over SSH and in tmux.

**Fix.** Compare the previous and next frames row by row. Leave the unchanged leading rows in place and erase and rewrite only from the first changed row. The erase count follows the same trailing-newline accounting as `previousLineCount`, so `clear()` and the cursor arithmetic stay consistent.

**Upstream.** Ink 6 moved towards incremental rendering. A backport to 5.x would be this hunk alone; it needs no API change.

## 6. Resize baseline invalidate (`ink.js`, `log-update.js`)

**Problem.** After a resize the terminal re-wraps the rows already on screen, so identical row bytes no longer sit on the same terminal rows. Hunk 5's "unchanged rows stay" assumption no longer holds, and stale fragments survive the next frame.

**Fix.** `log.invalidate()` forgets `previousOutput` but keeps the line count, so the old frame is still fully erased. `resized()` calls it and resets `lastOutput` before re-layout, which makes the next frame a full repaint.

**Upstream.** Belongs with hunk 5; it is only needed once diff-render exists.

## 7. Hardware cursor positioning (`ink.js`, `log-update.js`) — #41, #66

**Problem.** Ink hides the terminal cursor for its whole lifetime and leaves it on the line below the live region. Input methods (Chinese, Japanese and Korean IMEs, the macOS accent picker, dictation) open their preedit text and candidate window at the hardware cursor, so they appear in the wrong place. Some terminals suppress composition entirely while the cursor is hidden; Windows Terminal and some iTerm2 input methods have been reported to. Apps can only draw a fake cursor (an inverse cell), and the IME cannot see it.

**Fix.**

- A host marks its cursor cell with the `internal_cursor` host attribute; in Mercury this is `CursorCell` in `src/ui/cursor-anchor.tsx`. After each frame, and after the live-region trim, `onRender` walks the live tree. It skips `<Static>` and `display: none` subtrees and adds up Yoga offsets exactly as `render-node-to-output` does, which gives the cell's `{row, col}` inside the frame.
- `log(output, cursor)` writes the frame and then parks the cursor on that cell: `CUU n` + `CHA col` + `CSI ?25h`. Before any later write (`render`, `clear`, `done`, console re-logs) it unparks: `CSI ?25l` + `CUD n` + `CHA 1`. The erase arithmetic therefore always starts from the position it assumes: below the last row, column 0.
- The moves are relative on purpose. The live region's absolute row is unknown without a DSR round-trip, so absolute `CUP` would need terminal queries.
- If only the cursor moved and the rows are byte-identical, ink writes just the unpark/park pair. No frame text is written.
- With no marked element, for example while a prompt or a non-input pane owns the keyboard, the cursor stays hidden. `cursorAnchor.enabled = false` turns the feature off globally; Mercury sets it from `MERCURY_HW_CURSOR=0`.

The attribute lives on ink's DOM node instead of a ref for a reason. React attaches refs during the layout phase, *after* `resetAfterCommit` has already rendered the committed frame, so a ref-based anchor would always be one frame late. Nothing is inserted into the frame text, so no sentinel can leak into the terminal.

**Upstream.** Ink has no cursor API in 5.x. A proposal could be a public `useCursor()` hook or a `<Cursor />` marker component that resolves the same way, plus the park/unpark contract in log-update. The tests in `src/ui/hardware-cursor.test.tsx` show the expected byte sequences: wide characters, diff frames, cursor-only moves, trim, `<Static>` output, resize and unmount.


## 8. Synchronized output (`ink.js`, `log-update.js`)

**Problem.** A frame reaches the terminal as an erase followed by a redraw, and a new transcript line takes three writes: erase the live region, print the line, redraw. Terminals paint between those steps, so the user briefly sees the region blank or half-drawn. That is the flicker in iTerm2, kitty, WezTerm, Ghostty and Windows Terminal, and it is worst while a reply streams.

**Fix.** Bracket each update in BSU/ESU (`ESC[?2026h` … `ESC[?2026l`, DEC private mode 2026), so the terminal swaps the finished frame in at once.
- log-update brackets its own single writes. This also covers the throttled path, which writes after `onRender` returns.
- `Ink.synchronized()` brackets multi-write sequences (clear + static + frame, and the console write-through paths) as one update. log-update skips its own brackets while one is open.
- The gate matches upstream's `shouldSynchronize()`: a TTY, not CI, not debug.
- Terminals without mode 2026 ignore both sequences.

**Upstream.** Ink 6.7 shipped this (#866). This hunk is a backport, and it goes away with the move to Ink 8.

---

## Upgrading ink

1. Bump `INK_VERSION` and `INK_INTEGRITY` in `scripts/vendor-ink.cjs`. The integrity value is `dist.integrity` from `npm view ink@<v> dist.integrity`.
2. Run `node scripts/vendor-ink.cjs`. Any hunk whose anchor moved fails with a named error; re-anchor it in `scripts/apply-ink-patch.cjs`.
3. Review `patches/ink+<v>.patch`, then run `npx vitest run src/ui src/channels scripts/apply-ink-patch.test.ts` and `npx tsup && node dist/index.js --help`.
