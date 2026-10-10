/**
 * The Mercury ink patch set, as deterministic source edits on a stock
 * ink 8.0.0 build. Idempotent: checks for the fix markers first, then edits
 * the files DIRECTLY (no patch-package).
 *
 * Since ADR-017 the patched ink is VENDORED: `scripts/vendor-ink.cjs` runs
 * this applier against a stock tarball and commits the result to
 * `vendor/ink/`, which tsup/vitest alias `ink` to. This module is the single
 * source of truth for every hunk (docs/ink-patch.md has the rationale):
 *   1. Static.js / Static.d.ts — `itemKey` identity dedup, so a bounded
 *      sliding window of items is safe (upstream's positional index assumes
 *      append-only), plus the commitTick re-render that unmounts written
 *      children.
 *   2. ink.js — freeze gate (`globalThis.__mercuryFrameGate`): while frozen,
 *      no frame is written and no baseline advances (Ctrl+S scroll lock).
 *   3. ink.js — live-region guard: a live frame as tall as the viewport is
 *      trimmed to its newest rows instead of being written whole, so the
 *      overflow never scrolls copies of the live region into scrollback.
 *   4. ink.js — cursor anchor: the cell marked `internal_cursor` (Mercury's
 *      CursorCell) is resolved from the layout after every frame and fed to
 *      ink's own setCursorPosition, so IME preedit/candidate windows anchor
 *      on the input cell.
 *
 * Retired with the move to ink 8 (upstream now covers them): Yoga free-node
 * hygiene (freeYogaSubtree), diff-render (`incrementalRendering`), resize
 * baseline reset, hand-rolled cursor park/unpark, synchronized output.
 *
 * Loud on failure: a silent skip is never acceptable.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/** File paths for an ink build directory. `root` is overridable so tests
 * can exercise the applier against a synthetic ink tree, and `inkDir`
 * (the `build/` directory) can be given explicitly — that is how
 * scripts/vendor-ink.cjs patches the extracted stock tarball. */
function pathsFor(projectRoot, opts = {}) {
  let inkDir = opts.inkDir || path.join(projectRoot, 'node_modules', 'ink', 'build');
  if (!opts.inkDir) {
    try {
      const resolved = require.resolve('ink', { paths: [projectRoot] });
      if (fs.existsSync(resolved)) inkDir = path.dirname(resolved);
    } catch {
      // not installed / not resolvable — fall back to the conventional path
    }
  }
  return {
    inkDir,
    staticJsPath: path.join(inkDir, 'components', 'Static.js'),
    staticDtsPath: path.join(inkDir, 'components', 'Static.d.ts'),
    inkJsPath: path.join(inkDir, 'ink.js'),
  };
}

/** The committed vendored build (ADR-017). */
const VENDORED_INK_DIR = path.join(root, 'vendor', 'ink', 'build');

const paths = pathsFor(root);

const FRAME_GATE_MARKER = '__mercuryFrameGate';
const LIVE_REGION_MARKER = 'Live-region guard (Cosmic Stack patch)';
const CURSOR_ANCHOR_MARKER = '__mercuryCursorAnchor';
const STATIC_MARKER = 'Static itemKey (Cosmic Stack patch)';
const HUNKS = ['static-item-key', 'freeze-gate', 'live-region-guard', 'cursor-anchor'];

function isPatched(p = paths) {
  try {
    const staticJs = fs.readFileSync(p.staticJsPath, 'utf8');
    const staticDts = fs.readFileSync(p.staticDtsPath, 'utf8');
    const inkJs = fs.readFileSync(p.inkJsPath, 'utf8');
    return staticJs.includes(STATIC_MARKER)
      && staticJs.includes('setCommitTick')
      && staticDts.includes('itemKey')
      && inkJs.includes(FRAME_GATE_MARKER)
      && inkJs.includes(LIVE_REGION_MARKER)
      && inkJs.includes(CURSOR_ANCHOR_MARKER);
  } catch {
    return false;
  }
}

/** Replace exactly one occurrence of `anchor`, or throw naming the hunk. */
function replaceOnce(source, anchor, replacement, hunk) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`${hunk}: anchor not found — ink changed shape: ${JSON.stringify(anchor.slice(0, 80))}`);
  if (source.indexOf(anchor, at + anchor.length) >= 0) throw new Error(`${hunk}: anchor is ambiguous: ${JSON.stringify(anchor.slice(0, 80))}`);
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

/** Hunk 1: `<Static itemKey>`. */
function applyStaticItemKey(p = paths) {
  let s = fs.readFileSync(p.staticJsPath, 'utf8');
  if (!s.includes(STATIC_MARKER)) {
    const hunk = 'static-item-key';
    s = replaceOnce(s, "import React, { useMemo, useState, useLayoutEffect, use, } from 'react';",
      "import React, { useMemo, useState, useLayoutEffect, useRef, use, } from 'react';", hunk);
    s = replaceOnce(s, '    const { items, children: render, style: customStyle } = props;',
      '    const { items, children: render, style: customStyle, itemKey } = props;', hunk);
    s = replaceOnce(s, '    const [index, setIndex] = useState(0);\n', `    const [index, setIndex] = useState(0);
    // ${STATIC_MARKER}: with \`itemKey\`, items are tracked by identity and
    // each is written exactly once per instance, so a caller may keep \`items\`
    // bounded by dropping the oldest (a sliding window). The positional index
    // below assumes append-only: once old items drop off, \`items.slice(index)\`
    // returns nothing and new items are never written.
    const committedKeys = useRef(null);
    // Bumped after committing keys so the memo recomputes and the written
    // children unmount (the positional path does this via setIndex). Without
    // it they stay mounted and are re-emitted as static output every render.
    const [commitTick, setCommitTick] = useState(0);
`, hunk);
    s = replaceOnce(s, '    const itemsToRender = useMemo(() => items.slice(index), [items, index]);', `    const itemsToRender = useMemo(() => {
        if (typeof itemKey === 'function') {
            committedKeys.current ??= new Set();
            const committed = committedKeys.current;
            return items.filter((item) => {
                const key = itemKey(item);
                return key !== undefined && !committed.has(key);
            });
        }
        return items.slice(index);
    }, [items, index, itemKey, commitTick]);`, hunk);
    s = replaceOnce(s, '    useLayoutEffect(() => {\n        setIndex(items.length);\n    }, [items.length]);', `    useLayoutEffect(() => {
        if (typeof itemKey === 'function') {
            if (committedKeys.current && itemsToRender.length > 0) {
                for (const item of itemsToRender) {
                    committedKeys.current.add(itemKey(item));
                }
                setCommitTick((v) => v + 1);
            }
            return;
        }
        setIndex(items.length);
    }, [itemsToRender, itemKey, items.length]);`, hunk);
    fs.writeFileSync(p.staticJsPath, s);
  }
  let d = fs.readFileSync(p.staticDtsPath, 'utf8');
  if (!d.includes('itemKey')) {
    d = replaceOnce(d, '    readonly children: (item: T, index: number) => ReactNode;', `    /**
     * Stable identity for an item (Cosmic Stack patch). When set, items are
     * tracked by key instead of position, so \`items\` may drop its oldest
     * entries (a bounded window) without breaking. Return \`undefined\` to skip
     * an item.
     */
    readonly itemKey?: (item: T) => string | undefined;
    readonly children: (item: T, index: number) => ReactNode;`, 'static-item-key (d.ts)');
    fs.writeFileSync(p.staticDtsPath, d);
  }
  return true;
}

/** Hunks 2–4 all live in ink.js: module globals after `noop`, and the
 * onRender steps between render() and renderFrame(). */
function applyInkJs(p = paths) {
  let s = fs.readFileSync(p.inkJsPath, 'utf8');
  if (s.includes(FRAME_GATE_MARKER) && s.includes(LIVE_REGION_MARKER) && s.includes(CURSOR_ANCHOR_MARKER)) return true;
  const hunk = 'ink.js';
  s = replaceOnce(s, 'const noop = () => { };\n', `const noop = () => { };
// Freeze gate (Cosmic Stack patch): while frozen, onRender writes NOTHING and
// must not advance lastOutput or log-update's baseline, so the frame that
// ends the freeze diffs against what is really on screen. \`armed\` lets
// exactly one frame through (the "⏸ frozen" hint) if it contains \`marker\`.
export const frameGate = { frozen: false, armed: false, marker: '' };
globalThis.${FRAME_GATE_MARKER} = frameGate;
// Cursor anchor (Cosmic Stack patch): after every frame, the element marked
// with the \`internal_cursor\` attribute (Mercury's CursorCell) is located in
// the laid-out live tree and handed to ink's setCursorPosition, so the real
// terminal cursor (and with it IME preedit/candidate windows) sits on the
// input cell. \`enabled: false\` turns it off (MERCURY_HW_CURSOR=0).
export const cursorAnchor = { enabled: true };
globalThis.${CURSOR_ANCHOR_MARKER} = cursorAnchor;
// Patch manifest (Cosmic Stack): which hunks this build carries, and whether
// it is the vendored copy (stamped by scripts/vendor-ink.cjs).
export const inkPatch = {
    vendored: false,
    base: 'ink@8.0.0',
    hunks: [${HUNKS.map((h) => `'${h}'`).join(', ')}],
};
globalThis.__mercuryInkPatch = inkPatch;
// Depth-first search for the first element with a truthy \`internal_cursor\`
// attribute, accumulating Yoga offsets like render-node-to-output does.
// <Static> and display:none subtrees are never part of the live frame. The
// DOM attribute is read instead of a ref because refs attach in React's
// layout phase, after the frame has already been rendered.
const findCursorCell = (node, x, y) => {
    const yoga = node.yogaNode;
    if (!yoga || node.internal_static || node.style?.display === 'none') return undefined;
    const nx = x + yoga.getComputedLeft();
    const ny = y + yoga.getComputedTop();
    if (node.attributes?.internal_cursor) return { x: nx, y: ny };
    if (!Array.isArray(node.childNodes)) return undefined;
    for (const child of node.childNodes) {
        const hit = findCursorCell(child, nx, ny);
        if (hit) return hit;
    }
    return undefined;
};
`, hunk);
  s = replaceOnce(s,
    '        const { output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled);\n',
    `        let { output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled);
        // Freeze gate (Cosmic Stack patch): drop the frame entirely.
        if (frameGate.frozen && !(frameGate.armed && frameGate.marker && output.includes(frameGate.marker))) {
            return;
        }
        if (frameGate.armed) frameGate.armed = false;
        // ${LIVE_REGION_MARKER}: a live frame as tall as the viewport is
        // written whole by stock ink, and on the primary screen every row
        // past the viewport scrolls into scrollback, so each repaint while
        // a reply streams stamps another copy of the live region into the
        // user's history. Keep the newest rows (input, status bar, the live
        // tail) and send the trimmed frame through the normal diff path.
        const liveHeightBeforeTrim = outputHeight;
        if (this.interactive && !this.alternateScreen && !this.isScreenReaderEnabled && !this.options.debug && this.options.stdout.isTTY) {
            const viewportRows = getWindowSize(this.options.stdout).rows;
            if (outputHeight >= viewportRows) {
                const maxLiveRows = Math.max(1, viewportRows - 1);
                output = output.split('\\n').slice(-maxLiveRows).join('\\n');
                outputHeight = maxLiveRows;
            }
        }
        // Cursor anchor (Cosmic Stack patch): resolved after the trim, so the
        // row is relative to the rows actually written. Only a CHANGE is
        // pushed: setCursorPosition marks the cursor dirty, and a dirty
        // cursor forces a rewrite of an otherwise unchanged frame.
        if (cursorAnchor.enabled && !this.isScreenReaderEnabled) {
            const cell = findCursorCell(this.rootNode, 0, 0);
            const row = cell ? cell.y - (liveHeightBeforeTrim - outputHeight) : -1;
            const next = cell && row >= 0 ? { x: cell.x, y: row } : undefined;
            if (next?.x !== this.cursorPosition?.x || next?.y !== this.cursorPosition?.y) {
                this.setCursorPosition(next);
            }
        }
`, hunk);
  fs.writeFileSync(p.inkJsPath, s);
  return true;
}

function apply(opts = {}) {
  const p = pathsFor(opts.root ?? root, { inkDir: opts.inkDir });
  if (isPatched(p)) return { ok: true, applied: false };
  if (!fs.existsSync(p.inkJsPath)) {
    return { ok: false, applied: false, error: `ink build not found at ${p.inkDir}` };
  }
  try {
    applyStaticItemKey(p);
    applyInkJs(p);
  } catch (err) {
    return { ok: false, applied: true, error: err.message };
  }
  if (!isPatched(p)) {
    return { ok: false, applied: true, error: 'edits ran but the fix markers are still missing' };
  }
  return { ok: true, applied: true };
}

/** True when the committed vendored build carries every hunk. */
function isVendoredPatched() {
  return isPatched(pathsFor(root, { inkDir: VENDORED_INK_DIR }));
}

module.exports = { isPatched, apply, pathsFor, isVendoredPatched, VENDORED_INK_DIR, HUNKS };
