/**
 * The Mercury ink patch set, as deterministic source edits on a stock
 * ink 5.2.1 build. Idempotent: checks for the fix markers first, then edits
 * the files DIRECTLY — no patch-package dependency (patch-package itself
 * failed on Termux/npm-11 containers: `sh: 1: patch-package: not found`).
 *
 * Since ADR-017 the patched ink is VENDORED: `scripts/vendor-ink.cjs` runs
 * this applier against a stock tarball and commits the result to
 * `vendor/ink/`, which tsup/vitest alias `ink` to. This module is therefore
 * the single source of truth for every hunk (see docs/ink-patch.md for the
 * rationale behind each one):
 *   1. reconciler.js — freed-Yoga-node hygiene: null every JS reference in
 *      removed subtrees after freeRecursive, and clear the root's cached
 *      staticNode when the removed subtree contains it. Also guards ink's
 *      `#text` nodes (no childNodes array) in the traversal.
 *   2. Static.js — `itemKey` identity dedup so bounded sliding item windows
 *      are safe (the positional index assumes append-only), plus the
 *      commitTick re-render that unmounts written children (ink's renderer
 *      re-prints still-mounted static children on every render).
 *   3. Static.d.ts — the `itemKey` type.
 *   4. ink.js — freeze gate (`globalThis.__mercuryFrameGate`).
 *   5. ink.js — live-region guard (bottom-anchored trim instead of
 *      clearTerminal + full static re-dump).
 *   6. log-update.js — diff-render (rewrite from the first changed row).
 *   7. ink.js + log-update.js — resize baseline invalidate.
 *   8. ink.js + log-update.js — hardware cursor positioning
 *      (`internal_cursor` host attribute), so IME preedit/candidate
 *      windows anchor on the input cell.
 *   9. ink.js + log-update.js — synchronized output (DEC mode 2026): every
 *      frame is painted atomically; backport of ink 6.7 (#866).
 *
 * Loud on failure: a silent skip is never acceptable for a crash fix.
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
    // When Mercury is installed as a dependency (not globally), npm hoists ink
    // to the consumer's node_modules — `<root>/node_modules/ink` does not
    // exist. Resolve the ink that Node will actually load from this root;
    // the plain join above stays as the fallback (synthetic trees in tests
    // carry no package.json for the resolver to find).
    try {
      const resolved = require.resolve('ink', { paths: [projectRoot] });
      if (fs.existsSync(resolved)) inkDir = path.dirname(resolved);
    } catch {
      // not installed / not resolvable — fall back to the conventional path
    }
  }
  return {
    inkDir,
    reconcilerPath: path.join(inkDir, 'reconciler.js'),
    staticJsPath: path.join(inkDir, 'components', 'Static.js'),
    staticDtsPath: path.join(inkDir, 'components', 'Static.d.ts'),
    inkJsPath: path.join(inkDir, 'ink.js'),
    logUpdatePath: path.join(inkDir, 'log-update.js'),
    logUpdateDtsPath: path.join(inkDir, 'log-update.d.ts'),
  };
}

/** The committed vendored build (ADR-017). */
const VENDORED_INK_DIR = path.join(root, 'vendor', 'ink', 'build');

const paths = pathsFor(root);

function isPatched(p = paths) {
  try {
    const reconciler = fs.readFileSync(p.reconcilerPath, 'utf8');
    const staticComponent = fs.readFileSync(p.staticJsPath, 'utf8');
    const inkJs = fs.readFileSync(p.inkJsPath, 'utf8');
    const logUpdate = fs.readFileSync(p.logUpdatePath, 'utf8');
    return reconciler.includes('clearYogaRefs')
      && reconciler.includes('Array.isArray(node.childNodes)')
      && reconciler.includes('rootNode.staticNode = undefined')
      && reconciler.includes(YOGA_HYGIENE_MARKER)
      && staticComponent.includes('itemKey')
      && staticComponent.includes('setCommitTick')
      && logUpdate.includes('Diff-render (Cosmic Stack patch)')
      && logUpdate.includes(RESIZE_RESET_MARKER)
      && logUpdate.includes(CURSOR_MARKER)
      && inkJs.includes('maxLiveRows')
      && inkJs.includes(RESIZE_RESET_MARKER)
      && inkJs.includes(FRAME_GATE_MARKER)
      && inkJs.includes(CURSOR_ANCHOR_MARKER)
      && logUpdate.includes(SYNC_MARKER)
      && inkJs.includes(SYNC_MARKER);
  } catch {
    return false;
  }
}

const FRAME_GATE_MARKER = '__mercuryFrameGate';
const RESIZE_RESET_MARKER = 'Resize baseline reset (Cosmic Stack patch)';
const CURSOR_MARKER = 'Hardware cursor (Cosmic Stack patch)';
const CURSOR_ANCHOR_MARKER = '__mercuryCursorAnchor';
const YOGA_HYGIENE_MARKER = '__mercuryInkYogaHygiene';
const SYNC_MARKER = 'Synchronized output (Cosmic Stack patch)';

/**
 * Hardware cursor positioning (ADR-017, #41, #66). Stock ink hides the
 * terminal cursor for its whole lifetime and leaves it on the line below
 * the live region, so IME preedit/candidate windows anchor in the wrong
 * place and some terminals (Windows Terminal, iTerm2 with certain input
 * methods) suppress IME composition entirely while the cursor is hidden.
 *
 * The host marks its fake-cursor cell with the `internal_cursor` host
 * attribute (src/ui/cursor-anchor.tsx). After every frame, ink.js finds
 * that element in the live tree, sums Yoga's computed offsets (exactly the
 * arithmetic render-node-to-output uses), subtracts any rows the
 * live-region guard trimmed, and hands `{row, col}` to log-update. There
 * the frame write is followed by CUU + CHA + `CSI ?25h` ("park"), and every
 * later write starts with `CSI ?25l` + CUD + `CSI G` ("unpark") so the
 * erase arithmetic never sees a parked cursor. Relative moves are used on
 * purpose — the absolute row of the live region is unknown without a DSR
 * round-trip — and nothing is ever inserted into the frame text, so no
 * sentinel can leak into the terminal.
 */
function applyCursorPositioning(p = paths) {
  const { inkJsPath, logUpdatePath, logUpdateDtsPath } = p;
  let lu = fs.readFileSync(logUpdatePath, 'utf8');
  if (!lu.includes(CURSOR_MARKER)) {
    const stateAnchor = '    let hasHiddenCursor = false;';
    if (!lu.includes(stateAnchor)) return false;
    lu = lu.replace(stateAnchor, `${stateAnchor}
    // ${CURSOR_MARKER}: after a frame is written the
    // cursor sits on the line below the last row (column 0) — that is what
    // the erase arithmetic assumes. \`park\` moves it up onto the anchor cell
    // and shows it; \`unpark\` hides it and moves it back BEFORE anything else
    // is written, so the arithmetic never sees a parked cursor. Relative
    // moves (CUU/CUD/CHA) on purpose: the absolute row of the live region is
    // unknown without a DSR round-trip.
    let parked = null;
    const targetFor = (cursor, lineCount) => {
        if (!cursor) return null;
        const rows = lineCount - 1; // lineCount counts the trailing blank line
        if (!(cursor.row >= 0 && cursor.row < rows)) return null;
        return { up: rows - cursor.row, col: Math.max(0, Math.floor(cursor.col)) };
    };
    const unpark = () => {
        if (!parked) return '';
        const { up } = parked;
        parked = null;
        return ansiEscapes.cursorHide + ansiEscapes.cursorDown(up) + ansiEscapes.cursorLeft;
    };
    const park = (target) => {
        if (!target) return '';
        parked = target;
        return ansiEscapes.cursorUp(target.up) + ansiEscapes.cursorTo(target.col) + ansiEscapes.cursorShow;
    };`);
    const sigAnchor = '    const render = (str) => {';
    if (!lu.includes(sigAnchor)) return false;
    lu = lu.replace(sigAnchor, '    const render = (str, cursor) => {');
    const sameAnchor = `        if (output === previousOutput) {
            return;
        }`;
    if (!lu.includes(sameAnchor)) return false;
    lu = lu.replace(sameAnchor, `        if (output === previousOutput) {
            // ${CURSOR_MARKER}: same rows, but the anchor
            // may have moved or toggled — re-park without touching the frame.
            const target = targetFor(cursor, previousLineCount);
            const same = (!parked && !target) || (parked && target && parked.up === target.up && parked.col === target.col);
            if (!same) stream.write(unpark() + park(target));
            return;
        }`);
    const writeAnchor = "        stream.write(ansiEscapes.eraseLines(eraseCount) + nextRows.slice(firstChange).join('\\n') + '\\n');";
    if (!lu.includes(writeAnchor)) return false;
    lu = lu.replace(writeAnchor, "        stream.write(unpark() + ansiEscapes.eraseLines(eraseCount) + nextRows.slice(firstChange).join('\\n') + '\\n' + park(targetFor(cursor, previousLineCount)));");
    const clearAnchor = `    render.clear = () => {
        stream.write(ansiEscapes.eraseLines(previousLineCount));`;
    if (!lu.includes(clearAnchor)) return false;
    lu = lu.replace(clearAnchor, `    render.clear = () => {
        stream.write(unpark() + ansiEscapes.eraseLines(previousLineCount));`);
    const doneAnchor = '    render.done = () => {';
    if (!lu.includes(doneAnchor)) return false;
    lu = lu.replace(doneAnchor, `    render.done = () => {
        const restore = unpark();
        if (restore) stream.write(restore);`);
    fs.writeFileSync(logUpdatePath, lu);
  }

  // Types: keep the .d.ts honest for anyone reading the vendored build.
  if (fs.existsSync(logUpdateDtsPath)) {
    let dts = fs.readFileSync(logUpdateDtsPath, 'utf8');
    if (!dts.includes('invalidate')) {
      const anchor = '    done: () => void;\n    (str: string): void;';
      if (dts.includes(anchor)) {
        dts = dts.replace(anchor, `    done: () => void;
    /** Resize baseline reset (Cosmic Stack patch). */
    invalidate: () => void;
    /** Hardware cursor (Cosmic Stack patch): \`cursor\` is the live-frame cell to park the terminal cursor on. */
    (str: string, cursor?: { row: number; col: number } | null): void;`);
        fs.writeFileSync(logUpdateDtsPath, dts);
      }
    }
  }

  let ink = fs.readFileSync(inkJsPath, 'utf8');
  if (!ink.includes(CURSOR_ANCHOR_MARKER)) {
    const gateAnchor = `globalThis.${FRAME_GATE_MARKER} = frameGate;`;
    if (!ink.includes(gateAnchor)) return false;
    ink = ink.replace(gateAnchor, `${gateAnchor}
// ${CURSOR_MARKER}: ink hides the terminal cursor and
// leaves it below the live region, so IME preedit/candidate windows anchor
// in the wrong place and some terminals suppress IME entirely. A host marks
// its fake-cursor cell with the \`internal_cursor\` attribute (Mercury:
// src/ui/cursor-anchor.tsx); after every frame onRender finds that element
// in the live tree and log-update parks the real cursor on it. No marked
// element (non-input views) → the cursor stays hidden. \`enabled: false\`
// turns the feature off globally.
export const cursorAnchor = { enabled: true };
globalThis.${CURSOR_ANCHOR_MARKER} = cursorAnchor;
// Patch manifest (Cosmic Stack): which hunks this build carries, and whether
// it is the vendored copy (stamped by scripts/vendor-ink.cjs) or an
// in-place node_modules edit.
export const inkPatch = {
    vendored: false,
    hunks: ['yoga-hygiene', 'static-item-key', 'freeze-gate', 'live-region-guard', 'diff-render', 'resize-invalidate', 'cursor-positioning', 'synchronized-output'],
};
globalThis.__mercuryInkPatch = inkPatch;
const sameCursor = (a, b) => (!a && !b) || (!!a && !!b && a.row === b.row && a.col === b.col);
// Depth-first search for the first element carrying a truthy
// \`internal_cursor\` attribute, accumulating Yoga offsets exactly like
// render-node-to-output does. <Static> subtrees and display:none subtrees
// are never part of the live frame and are skipped. Reading the DOM
// attribute (set in createInstance/commitUpdate) instead of a ref matters:
// refs attach in React's layout phase, AFTER resetAfterCommit has already
// rendered the frame, so a ref-based anchor would always lag one frame.
const findCursorCell = (node, x, y) => {
    const yoga = node.yogaNode;
    if (!yoga || node.internal_static || node.style?.display === 'none') return null;
    const nx = x + yoga.getComputedLeft();
    const ny = y + yoga.getComputedTop();
    if (node.attributes?.internal_cursor) return { row: ny, col: nx };
    if (!Array.isArray(node.childNodes)) return null;
    for (const child of node.childNodes) {
        const hit = findCursorCell(child, nx, ny);
        if (hit) return hit;
    }
    return null;
};`);
    const onRenderAnchor = '    onRender = () => {';
    if (!ink.includes(onRenderAnchor)) return false;
    ink = ink.replace(onRenderAnchor, `    // ${CURSOR_MARKER}: absolute cell of the marked cursor
    // element inside the live frame, or null when there is none, the feature
    // is disabled, or the cell was trimmed away by the live-region guard.
    lastCursor = null;
    resolveCursor(trimmedRows) {
        if (!cursorAnchor.enabled) return null;
        const cell = findCursorCell(this.rootNode, 0, 0);
        if (!cell) return null;
        const row = cell.row - trimmedRows;
        if (row < 0) return null;
        return { row, col: cell.col };
    }
${onRenderAnchor}`);
    const maxRowsAnchor = '        const maxLiveRows = Math.max(1, (this.options.stdout.rows || 24) - 1);';
    if (!ink.includes(maxRowsAnchor)) return false;
    ink = ink.replace(maxRowsAnchor, `${maxRowsAnchor}
        const liveHeightBeforeTrim = outputHeight;`);
    const trimEndAnchor = `            outputHeight = maxLiveRows;
        }`;
    if (!ink.includes(trimEndAnchor)) return false;
    ink = ink.replace(trimEndAnchor, `${trimEndAnchor}
        // ${CURSOR_MARKER}: resolve AFTER the trim so the row
        // is relative to the rows actually written.
        const cursor = this.resolveCursor(liveHeightBeforeTrim - outputHeight);`);
    const staticLogAnchor = `            this.options.stdout.write(staticOutput);
            this.log(output);`;
    if (!ink.includes(staticLogAnchor)) return false;
    ink = ink.replace(staticLogAnchor, `            this.options.stdout.write(staticOutput);
            this.log(output, cursor);`);
    const tailAnchor = `        if (!hasStaticOutput && output !== this.lastOutput) {
            this.throttledLog(output);
        }
        this.lastOutput = output;
    };`;
    if (!ink.includes(tailAnchor)) return false;
    ink = ink.replace(tailAnchor, `        if (!hasStaticOutput && (output !== this.lastOutput || !sameCursor(cursor, this.lastCursor))) {
            this.throttledLog(output, cursor);
        }
        this.lastOutput = output;
        this.lastCursor = cursor;
    };`);
    // console patching re-prints the last frame after foreign writes: keep the
    // cursor parked where it was.
    const relog = '        this.log(this.lastOutput);';
    if (!ink.includes(relog)) return false;
    ink = ink.split(relog).join('        this.log(this.lastOutput, this.lastCursor);');
    fs.writeFileSync(inkJsPath, ink);
  }
  return lu.includes(CURSOR_MARKER) && ink.includes(CURSOR_ANCHOR_MARKER);
}

/** Resize baseline reset: after a terminal resize the rows already on
 * screen have re-wrapped, so the diff-render's "unchanged rows above stay"
 * assumption is false — identical row BYTES no longer sit at the same
 * terminal rows. Ink's `resized` handler now drops `lastOutput` and
 * log-update's `previousOutput` baseline (keeping the line count, so the
 * erase still covers the old frame) and the next frame repaints whole.
 * Applies to both ink.js and log-update.js (after the diff-render edit). */
/** Synchronized output: bracket every frame write in BSU/ESU (DEC private
 * mode 2026) so the terminal swaps it in atomically — no visible gap between
 * the erase and the redraw, which is the flicker modern terminals show.
 * Terminals without 2026 ignore both sequences. log-update brackets its own
 * single writes (that also covers the throttled path, which writes later);
 * ink.js brackets multi-write sequences (clear + static + frame) as one
 * update, and log-update skips its own brackets while one is open.
 * Runs after the cursor hunk: it rewrites the unpark() writes that hunk adds. */
function applySynchronizedOutput(p = paths) {
  const { logUpdatePath, inkJsPath } = p;
  let lu = fs.readFileSync(logUpdatePath, 'utf8');
  let ink = fs.readFileSync(inkJsPath, 'utf8');
  if (lu.includes(SYNC_MARKER) && ink.includes(SYNC_MARKER)) return true;
  if (!lu.includes(SYNC_MARKER)) {
    const createAnchor = 'const create = (stream, { showCursor = false } = {}) => {';
    const clearAnchor = '    render.clear = () => {';
    if (!lu.includes(createAnchor) || !lu.includes(clearAnchor)) return false;
    const writes = lu.split('stream.write(unpark()').length - 1;
    if (writes < 2) return false;
    lu = lu.replace(createAnchor, `// ${SYNC_MARKER}: see ink.js synchronized().
const BSU = '\\u001B[?2026h';
const ESU = '\\u001B[?2026l';
const create = (stream, { showCursor = false, synchronize = false } = {}) => {
    // One atomic update per write, unless ink.js already opened one.
    const syncWrite = (data) => stream.write(synchronize && !(render.syncDepth > 0) ? BSU + data + ESU : data);`);
    lu = lu.split('stream.write(unpark()').join('syncWrite(unpark()');
    lu = lu.replace(clearAnchor, `    render.synchronize = synchronize;
    render.syncDepth = 0;
${clearAnchor}`);
  }
  if (!ink.includes(SYNC_MARKER)) {
    const createAnchor = 'this.log = logUpdate.create(options.stdout);';
    const staticAnchor = '            this.log.clear();\n            this.options.stdout.write(staticOutput);\n            this.log(output, cursor);';
    const writeToAnchor = '    writeToStdout(data) {';
    if (!ink.includes(createAnchor) || !ink.includes(staticAnchor) || !ink.includes(writeToAnchor)) return false;
    ink = ink.replace(createAnchor, `// ${SYNC_MARKER}: same gate as upstream shouldSynchronize().
        this.log = logUpdate.create(options.stdout, { synchronize: Boolean(options.stdout.isTTY) && !isInCi && !options.debug });`);
    ink = ink.replace(staticAnchor, `            this.synchronized(() => {
                this.log.clear();
                this.options.stdout.write(staticOutput);
                this.log(output, cursor);
            });`);
    for (const stream of ['stdout', 'stderr']) {
      const block = `        this.log.clear();\n        this.options.${stream}.write(data);\n        this.log(this.lastOutput, this.lastCursor);`;
      if (ink.includes(block)) {
        ink = ink.replace(block, `        this.synchronized(() => {
            this.log.clear();
            this.options.${stream}.write(data);
            this.log(this.lastOutput, this.lastCursor);
        });`);
      }
    }
    ink = ink.replace(writeToAnchor, `    // ${SYNC_MARKER}: run several writes as ONE terminal update (DEC
    // mode 2026), so a new transcript line and the redrawn live region
    // appear together instead of erase → static → redraw.
    synchronized(write) {
        const log = this.log;
        if (!log.synchronize) {
            write();
            return;
        }
        this.options.stdout.write('\\u001B[?2026h');
        log.syncDepth++;
        try {
            write();
        }
        finally {
            log.syncDepth--;
            this.options.stdout.write('\\u001B[?2026l');
        }
    }
${writeToAnchor}`);
  }
  fs.writeFileSync(logUpdatePath, lu);
  fs.writeFileSync(inkJsPath, ink);
  return true;
}

function applyResizeBaselineReset(p = paths) {
  const { inkJsPath, logUpdatePath } = p;
  let lu = fs.readFileSync(logUpdatePath, 'utf8');
  if (!lu.includes(RESIZE_RESET_MARKER)) {
    const anchor = '    render.clear = () => {';
    if (!lu.includes(anchor)) return false;
    lu = lu.replace(anchor, `    // ${RESIZE_RESET_MARKER}: forget what is on screen
    // without touching the line count — the next render erases the old
    // frame's rows and rewrites every row instead of diffing against rows
    // the terminal has already re-wrapped.
    render.invalidate = () => {
        previousOutput = '';
    };
${anchor}`);
    fs.writeFileSync(logUpdatePath, lu);
  }
  let ink = fs.readFileSync(inkJsPath, 'utf8');
  if (!ink.includes(RESIZE_RESET_MARKER)) {
    const anchor = `    resized = () => {
        this.calculateLayout();
        this.onRender();
    };`;
    if (!ink.includes(anchor)) return false;
    ink = ink.replace(anchor, `    resized = () => {
        // ${RESIZE_RESET_MARKER}: rows that re-wrapped on
        // resize must be repainted even when their bytes did not change, so
        // the diff-render baseline (ours and log-update's) is dropped first.
        this.lastOutput = '';
        if (typeof this.log.invalidate === 'function') this.log.invalidate();
        this.calculateLayout();
        this.onRender();
    };`);
    fs.writeFileSync(inkJsPath, ink);
  }
  return lu.includes(RESIZE_RESET_MARKER) && ink.includes(RESIZE_RESET_MARKER);
}

/** Diff-render log-update + freeze gate. Both live in already-patched
 * files, so this is an idempotent string-insert on the applied state. */
function applyInkFrameGate(p = paths) {
  const { inkJsPath } = p;
  let s = fs.readFileSync(inkJsPath, 'utf8');
  if (s.includes(FRAME_GATE_MARKER)) return true;
  const noopAnchor = "const noop = () => { };";
  if (!s.includes(noopAnchor)) return false;
  s = s.replace(noopAnchor, `${noopAnchor}
// Freeze gate (Cosmic Stack patch): while frozen, onRender writes NOTHING
// and must not advance lastOutput / log-update's baseline — the resume frame
// must diff against the last frame actually on screen. \`armed\` lets exactly
// one frame through (the "⏸ frozen" hint) if its output contains \`marker\`.
// Exposed on globalThis so host code can reach it without a type-level
// import of this internal module.
export const frameGate = { frozen: false, armed: false, marker: '' };
globalThis.${FRAME_GATE_MARKER} = frameGate;`);
  const renderAnchor = "        const { output, outputHeight, staticOutput } = render(this.rootNode);";
  if (!s.includes(renderAnchor)) return false;
  s = s.replace(renderAnchor, `${renderAnchor}
        // Freeze gate (Cosmic Stack patch): drop the frame entirely — no
        // write, and crucially NO advance of \`lastOutput\` or log-update's
        // \`previousOutput\`/\`previousLineCount\` baseline, so the frame that
        // ends the freeze diffs against what is actually on screen.
        if (frameGate.frozen && !(frameGate.armed && frameGate.marker && output.includes(frameGate.marker))) {
            return;
        }
        if (frameGate.armed) frameGate.armed = false;`);
  fs.writeFileSync(inkJsPath, s);
  return true;
}

/** Live-region guard: a live frame as tall as (or taller than) the terminal
 * must NEVER go through stock ink's fallback — `clearTerminal + full
 * static re-dump` — which erases scrollback and re-prints every static byte
 * on every frame. Bottom-anchored trim keeps the newest rows instead.
 * Inserts right after the freeze gate (both edits live in ink.js). */
function applyInkLiveRegionGuard(p = paths) {
  const { inkJsPath } = p;
  let s = fs.readFileSync(inkJsPath, 'utf8');
  if (s.includes('maxLiveRows')) return true;
  const gateAnchor = '        if (frameGate.armed) frameGate.armed = false;';
  if (!s.includes(gateAnchor)) return false;
  s = s.replace(gateAnchor, `${gateAnchor}
        // Live-region guard (Cosmic Stack patch): a live frame as tall as (or
        // taller than) the terminal cannot go through log-update's cursor
        // arithmetic, and stock ink's fallback is \`clearTerminal +
        // fullStaticOutput + output\` — erasing the ENTIRE scrollback buffer
        // and re-dumping every static byte ever printed, on EVERY frame. With
        // a long transcript that is megabytes per frame: the scrollbar jumps
        // to the top, the UI flickers, and native scrolling becomes
        // impossible. Instead keep the frame bottom-anchored: trim to what
        // fits (rows - 1) and let the normal diff path write it. Scrollback
        // is never cleared, the transcript is never re-dumped, and the newest
        // rows (live tail, input, status bar) stay visible.
        const maxLiveRows = Math.max(1, (this.options.stdout.rows || 24) - 1);
        if (outputHeight >= (this.options.stdout.rows || 24)) {
            // \`output\` is newline-terminated per row WITHOUT a trailing blank
            // line (log-update appends its own), so split and re-join verbatim.
            output = output.split('\\n').slice(-maxLiveRows).join('\\n');
            outputHeight = maxLiveRows;
        }`);
  // The trim reassigns output/outputHeight — the declaration must be `let`.
  const constLine = 'const { output, outputHeight, staticOutput } = render(this.rootNode);';
  if (s.includes(constLine)) s = s.replace(constLine, 'let { output, outputHeight, staticOutput } = render(this.rootNode);');
  fs.writeFileSync(inkJsPath, s);
  return s.includes('maxLiveRows');
}

/** Diff-render log-update: erase and rewrite only the rows from the first
 * changed line onward. Stock ink 5 erased and rewrote the ENTIRE frame on
 * every render — a prompt-selection toggle or spinner tick repainted the
 * whole live region (a full-UI flash per keystroke). */
function applyLogUpdateDiffRender(p = paths) {
  const { logUpdatePath } = p;
  let s = fs.readFileSync(logUpdatePath, 'utf8');
  if (s.includes('Diff-render (Cosmic Stack patch)')) return true;
  const anchor = [
    '        previousOutput = output;',
    '        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);',
    "        previousLineCount = output.split('\\n').length;",
  ].join('\n');
  if (!s.includes(anchor)) return false;
  const replacement = [
    '        // Diff-render (Cosmic Stack patch): erase and rewrite only the rows',
    '        // from the first changed line onward; identical rows above stay on',
    '        // screen untouched. Ink 5\'s log-update erased and rewrote the ENTIRE',
    '        // frame on every render — a prompt-selection change or spinner tick',
    '        // repainted the whole live region, which read as a full-UI flash.',
    '        // The row bytes are compared verbatim (layout is deterministic), and',
    '        // the erase count accounts for the trailing blank line exactly like',
    '        // `previousLineCount` does, so `clear()` and cursor arithmetic stay',
    '        // in sync with the original accounting.',
    "        const previousRows = previousOutput === '' ? [] : previousOutput.slice(0, -1).split('\\n');",
    "        const nextRows = output.slice(0, -1).split('\\n');",
    '        const common = Math.min(previousRows.length, nextRows.length);',
    '        let firstChange = 0;',
    '        while (firstChange < common && previousRows[firstChange] === nextRows[firstChange]) {',
    '            firstChange++;',
    '        }',
    '        const eraseCount = previousLineCount - firstChange;',
    '        previousOutput = output;',
    "        previousLineCount = output.split('\\n').length;",
    "        stream.write(ansiEscapes.eraseLines(eraseCount) + nextRows.slice(firstChange).join('\\n') + '\\n');",
  ].join('\n');
  s = s.replace(anchor, replacement, 1);
  fs.writeFileSync(logUpdatePath, s);
  return s.includes('Diff-render (Cosmic Stack patch)');
}

function applyReconcilerFix(p = paths) {
  const { reconcilerPath } = p;
  let s = fs.readFileSync(reconcilerPath, 'utf8');
  if (s.includes('clearYogaRefs')) {
    const marked = addYogaHygieneMarker(s);
    if (marked !== s) fs.writeFileSync(reconcilerPath, marked);
    return true;
  }

  // 1a. Insert the freed-subtree hygiene helpers after cleanupYogaNode.
  const anchorA = `const cleanupYogaNode = (node) => {
    node?.unsetMeasureFunc();
    node?.freeRecursive();
};`;
  const helpers = `${anchorA}
// \`freeRecursive\` releases Yoga's WASM memory but leaves every JavaScript
// reference pointing at freed memory. The renderer and layout code read those
// references through optional chaining, so nulling them here turns what was a
// fatal WASM trap ("RuntimeError: memory access out of bounds" in
// getComputedWidth) into a clean no-op. See facebook/yoga#1818 and the
// equivalent downstream fix in qwen-code#7816. (Cosmic Stack patch.)
const clearYogaRefs = (node) => {
    node.yogaNode = undefined;
    // Host elements carry a childNodes array; ink's \`#text\` nodes do not.
    if (Array.isArray(node.childNodes)) {
        for (const child of node.childNodes) {
            clearYogaRefs(child);
        }
    }
};
const containsNode = (ancestor, target) => {
    let current = target;
    while (current) {
        if (current === ancestor) return true;
        current = current.parentNode;
    }
    return false;
};
const cleanupRemovedNode = (node, removeNode) => {
    cleanupYogaNode(removeNode.yogaNode);
    clearYogaRefs(removeNode);
    // \`staticNode\` is cached on the root container, but removeChild receives
    // the direct parent — climb to the root before checking.
    let rootNode = node;
    while (rootNode?.parentNode) rootNode = rootNode.parentNode;
    if (rootNode?.staticNode && containsNode(removeNode, rootNode.staticNode)) {
        rootNode.staticNode = undefined;
    }
};`;
  if (!s.includes(anchorA)) return false;
  s = s.replace(anchorA, helpers, 1);

  // 1b. Route both removal paths through cleanupRemovedNode.
  const oldRemoval = `        removeChildNode(node, removeNode);
        cleanupYogaNode(removeNode.yogaNode);`;
  const newRemoval = `        removeChildNode(node, removeNode);
        cleanupRemovedNode(node, removeNode);`;
  let count = 0;
  while (s.includes(oldRemoval)) {
    s = s.replace(oldRemoval, newRemoval, 1);
    count += 1;
  }
  if (count === 0) return false;
  s = addYogaHygieneMarker(s);
  fs.writeFileSync(reconcilerPath, s);
  return true;
}

/** Runtime marker for the hygiene hunk: the bundled/vendored build has no
 * readable reconciler.js on disk, so src/ui/ink-patch-check.ts reads this
 * global instead of the file. Idempotent; also upgrades builds patched
 * before the marker existed. */
function addYogaHygieneMarker(source) {
  if (source.includes(YOGA_HYGIENE_MARKER)) return source;
  const anchor = 'export default createReconciler({';
  if (!source.includes(anchor)) return source;
  return source.replace(anchor, `globalThis.${YOGA_HYGIENE_MARKER} = true;\n${anchor}`);
}

const PATCHED_STATIC_JS = `import React, { useMemo, useState, useLayoutEffect, useRef } from 'react';
/**
 * \`<Static>\` component permanently renders its output above everything else.
 * It's useful for displaying activity like completed tasks or logs - things that
 * are not changing after they're rendered (hence the name "Static").
 *
 * It's preferred to use \`<Static>\` for use cases like these, when you can't know
 * or control the amount of items that need to be rendered.
 *
 * For example, [Tap](https://github.com/tapjs/node-tap) uses \`<Static>\` to display
 * a list of completed tests. [Gatsby](https://github.com/gatsbyjs/gatsby) uses it
 * to display a list of generated pages, while still displaying a live progress bar.
 *
 * Patched (Cosmic Stack): supports an optional \`itemKey\` identity function.
 * The built-in positional index assumes \`items\` only ever appends — a caller
 * that keeps the array bounded by dropping the oldest items (a sliding
 * window) breaks it: \`items.slice(index)\` returns nothing, new items are
 * never rendered, and every commit unmounts the whole subtree. With
 * \`itemKey\`, each item is tracked by identity and rendered exactly once per
 * instance lifetime, so bounded sliding windows are safe.
 */
export default function Static(props) {
    const { items, children: render, style: customStyle, itemKey } = props;
    const [index, setIndex] = useState(0);
    // Identity of items already written to the terminal in this instance.
    // Only used when \`itemKey\` is provided.
    const committedKeys = useRef(null);
    // Bumped after committing keys so the memo recomputes and the rendered
    // children are unmounted — the positional path does this via setIndex.
    // Without it, committed children stay mounted and the renderer keeps
    // re-printing them into the terminal on EVERY subsequent render (each
    // pass re-emits \`staticOutput\` while the nodes are still attached).
    const [commitTick, setCommitTick] = useState(0);
    const itemsToRender = useMemo(() => {
        if (typeof itemKey === 'function') {
            if (!committedKeys.current) {
                committedKeys.current = new Set();
            }
            const committed = committedKeys.current;
            const out = [];
            for (const item of items) {
                const key = itemKey(item);
                if (key !== undefined && !committed.has(key)) {
                    out.push(item);
                }
            }
            return out;
        }
        return items.slice(index);
    }, [items, index, itemKey, commitTick]);
    useLayoutEffect(() => {
        if (typeof itemKey === 'function') {
            if (committedKeys.current && itemsToRender.length > 0) {
                for (const item of itemsToRender) {
                    committedKeys.current.add(itemKey(item));
                }
                // Unmount what was just written: without this, the nodes stay
                // attached and every later render re-prints them (duplicate
                // transcript lines accumulating over time).
                setCommitTick((v) => v + 1);
            }
            return;
        }
        setIndex(items.length);
    }, [itemsToRender, itemKey, items.length]);
    const children = itemsToRender.map((item, itemIndex) => {
        return render(item, itemIndex);
    });
    const style = useMemo(() => ({
        position: 'absolute',
        flexDirection: 'column',
        ...customStyle,
    }), [customStyle]);
    return (React.createElement("ink-box", { internal_static: true, style: style }, children));
}
//# sourceMappingURL=Static.js.map`;

const ITEMKEY_DTS = `    /**
     * Optional identity function used to track which items have already been
     * rendered. When provided, each item is rendered exactly once per
     * \`<Static>\` instance lifetime even if the \`items\` array is kept bounded
     * by shifting the window (which the built-in positional index cannot
     * handle). Keys returning \`undefined\` are ignored.
     */
    readonly itemKey?: (item: T) => string | undefined;
};`;

function applyStaticFix(p = paths) {
  const { staticJsPath, staticDtsPath } = p;
  const staticJs = fs.readFileSync(staticJsPath, 'utf8');
  if (staticJs.includes('itemKey')) {
    // Already (partially) applied — ensure the commitTick variant.
    if (staticJs.includes('setCommitTick')) return true;
    fs.writeFileSync(staticJsPath, PATCHED_STATIC_JS);
    return true;
  }
  fs.writeFileSync(staticJsPath, PATCHED_STATIC_JS);

  const dts = fs.readFileSync(staticDtsPath, 'utf8');
  if (!dts.includes('itemKey')) {
    const anchor = '    readonly children: (item: T, index: number) => ReactNode;\n};';
    if (dts.includes(anchor)) {
      fs.writeFileSync(staticDtsPath, dts.replace(anchor, `    readonly children: (item: T, index: number) => ReactNode;\n${ITEMKEY_DTS}`));
    }
  }
  return true;
}

/**
 * Apply every hunk to an ink build. `opts.inkDir` targets a `build/`
 * directory directly (vendoring); otherwise the ink resolvable from
 * `opts.root` (default: this checkout's node_modules) is patched in place.
 */
function apply(opts = {}) {
  const p = pathsFor(opts.root ?? root, { inkDir: opts.inkDir });
  if (isPatched(p)) return { ok: true, applied: false };
  if (!fs.existsSync(p.reconcilerPath)) {
    return { ok: false, applied: false, error: `ink build not found at ${p.inkDir}` };
  }
  try {
    const reconcilerOk = applyReconcilerFix(p);
    const staticOk = applyStaticFix(p);
    const frameGateOk = applyInkFrameGate(p);
    const liveRegionOk = applyInkLiveRegionGuard(p);
    const diffRenderOk = applyLogUpdateDiffRender(p);
    const resizeResetOk = applyResizeBaselineReset(p);
    const cursorOk = applyCursorPositioning(p);
    const syncOk = cursorOk && applySynchronizedOutput(p);
    if (!cursorOk) {
      return { ok: false, applied: true, error: 'hardware cursor positioning could not be inserted (ink.js onRender / log-update.js render anchors)' };
    }
    if (!syncOk) {
      return { ok: false, applied: true, error: 'synchronized output could not be inserted (ink.js log/static/writeToStdout or log-update.js create/clear anchors)' };
    }
    if (!reconcilerOk) {
      return { ok: false, applied: true, error: 'reconciler.js no longer matches the expected ink 5.2.1 shape — patch anchors not found' };
    }
    if (!staticOk) {
      return { ok: false, applied: true, error: 'Static.js could not be rewritten' };
    }
    if (!frameGateOk) {
      return { ok: false, applied: true, error: 'ink.js frame gate could not be inserted' };
    }
    if (!liveRegionOk) {
      return { ok: false, applied: true, error: 'ink.js live-region guard could not be inserted' };
    }
    if (!diffRenderOk) {
      return { ok: false, applied: true, error: 'log-update.js diff-render could not be inserted' };
    }
    if (!resizeResetOk) {
      return { ok: false, applied: true, error: 'resize baseline reset could not be inserted (ink.js resized / log-update.js clear anchors)' };
    }
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

module.exports = { isPatched, apply, pathsFor, isVendoredPatched, VENDORED_INK_DIR };

if (require.main === module) {
  // CLI: `node scripts/apply-ink-patch.cjs [--ink-dir <build dir>]`. Without
  // an explicit dir this patches node_modules/ink in place — only useful for
  // experiments now that the runtime uses vendor/ink (scripts/vendor-ink.cjs).
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf('--ink-dir');
  const inkDir = dirFlag >= 0 ? path.resolve(argv[dirFlag + 1] || '') : undefined;
  const result = apply({ inkDir });
  if (result.ok && result.applied) {
    console.log('  ✓ ink fixes applied (Yoga hygiene, Static.itemKey, freeze gate, live-region guard, diff-render, resize invalidate, hardware cursor)');
  } else if (result.ok) {
    console.log('  ✓ ink fixes already applied');
  } else {
    console.error('  ⚠ INK FIXES NOT APPLIED — the Yoga WASM crash class is UNPATCHED in this build.');
    console.error(`    Reason: ${result.error}`);
    console.error('    Fix: node scripts/vendor-ink.cjs (regenerates vendor/ink from the stock tarball).');
    process.exitCode = 1;
  }
}