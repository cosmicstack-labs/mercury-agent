import process from 'node:process';
import React from 'react';
import { throttle } from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import Yoga from 'yoga-layout';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import logUpdate from './log-update.js';
import instances from './instances.js';
import App from './components/App.js';
const noop = () => { };
// Freeze gate (Cosmic Stack patch): while frozen, onRender writes NOTHING
// and must not advance lastOutput / log-update's baseline — the resume frame
// must diff against the last frame actually on screen. `armed` lets exactly
// one frame through (the "⏸ frozen" hint) if its output contains `marker`.
// Exposed on globalThis so host code can reach it without a type-level
// import of this internal module.
export const frameGate = { frozen: false, armed: false, marker: '' };
globalThis.__mercuryFrameGate = frameGate;
// Hardware cursor (Cosmic Stack patch): ink hides the terminal cursor and
// leaves it below the live region, so IME preedit/candidate windows anchor
// in the wrong place and some terminals suppress IME entirely. A host marks
// its fake-cursor cell with the `internal_cursor` attribute (Mercury:
// src/ui/cursor-anchor.tsx); after every frame onRender finds that element
// in the live tree and log-update parks the real cursor on it. No marked
// element (non-input views) → the cursor stays hidden. `enabled: false`
// turns the feature off globally.
export const cursorAnchor = { enabled: true };
globalThis.__mercuryCursorAnchor = cursorAnchor;
// Patch manifest (Cosmic Stack): which hunks this build carries, and whether
// it is the vendored copy (stamped by scripts/vendor-ink.cjs) or an
// in-place node_modules edit.
export const inkPatch = {
    vendored: true,
    hunks: ['yoga-hygiene', 'static-item-key', 'freeze-gate', 'live-region-guard', 'diff-render', 'resize-invalidate', 'cursor-positioning'],
};
globalThis.__mercuryInkPatch = inkPatch;
const sameCursor = (a, b) => (!a && !b) || (!!a && !!b && a.row === b.row && a.col === b.col);
// Depth-first search for the first element carrying a truthy
// `internal_cursor` attribute, accumulating Yoga offsets exactly like
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
};
export default class Ink {
    options;
    log;
    throttledLog;
    // Ignore last render after unmounting a tree to prevent empty output before exit
    isUnmounted;
    lastOutput;
    container;
    rootNode;
    // This variable is used only in debug mode to store full static output
    // so that it's rerendered every time, not just new static parts, like in non-debug mode
    fullStaticOutput;
    exitPromise;
    restoreConsole;
    unsubscribeResize;
    constructor(options) {
        autoBind(this);
        this.options = options;
        this.rootNode = dom.createNode('ink-root');
        this.rootNode.onComputeLayout = this.calculateLayout;
        this.rootNode.onRender = options.debug
            ? this.onRender
            : throttle(this.onRender, 32, {
                leading: true,
                trailing: true,
            });
        this.rootNode.onImmediateRender = this.onRender;
        this.log = logUpdate.create(options.stdout);
        this.throttledLog = options.debug
            ? this.log
            : throttle(this.log, undefined, {
                leading: true,
                trailing: true,
            });
        // Ignore last render after unmounting a tree to prevent empty output before exit
        this.isUnmounted = false;
        // Store last output to only rerender when needed
        this.lastOutput = '';
        // This variable is used only in debug mode to store full static output
        // so that it's rerendered every time, not just new static parts, like in non-debug mode
        this.fullStaticOutput = '';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.container = reconciler.createContainer(this.rootNode, 
        // Legacy mode
        0, null, false, null, 'id', () => { }, null);
        // Unmount when process exits
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (process.env['DEV'] === 'true') {
            reconciler.injectIntoDevTools({
                bundleType: 0,
                // Reporting React DOM's version, not Ink's
                // See https://github.com/facebook/react/issues/16666#issuecomment-532639905
                version: '16.13.1',
                rendererPackageName: 'ink',
            });
        }
        if (options.patchConsole) {
            this.patchConsole();
        }
        if (!isInCi) {
            options.stdout.on('resize', this.resized);
            this.unsubscribeResize = () => {
                options.stdout.off('resize', this.resized);
            };
        }
    }
    resized = () => {
        // Resize baseline reset (Cosmic Stack patch): rows that re-wrapped on
        // resize must be repainted even when their bytes did not change, so
        // the diff-render baseline (ours and log-update's) is dropped first.
        this.lastOutput = '';
        if (typeof this.log.invalidate === 'function') this.log.invalidate();
        this.calculateLayout();
        this.onRender();
    };
    resolveExitPromise = () => { };
    rejectExitPromise = () => { };
    unsubscribeExit = () => { };
    calculateLayout = () => {
        // The 'columns' property can be undefined or 0 when not using a TTY.
        // In that case we fall back to 80.
        const terminalWidth = this.options.stdout.columns || 80;
        this.rootNode.yogaNode.setWidth(terminalWidth);
        this.rootNode.yogaNode.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    };
    // Hardware cursor (Cosmic Stack patch): absolute cell of the marked cursor
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
    onRender = () => {
        if (this.isUnmounted) {
            return;
        }
        let { output, outputHeight, staticOutput } = render(this.rootNode);
        // Freeze gate (Cosmic Stack patch): drop the frame entirely — no
        // write, and crucially NO advance of `lastOutput` or log-update's
        // `previousOutput`/`previousLineCount` baseline, so the frame that
        // ends the freeze diffs against what is actually on screen.
        if (frameGate.frozen && !(frameGate.armed && frameGate.marker && output.includes(frameGate.marker))) {
            return;
        }
        if (frameGate.armed) frameGate.armed = false;
        // Live-region guard (Cosmic Stack patch): a live frame as tall as (or
        // taller than) the terminal cannot go through log-update's cursor
        // arithmetic, and stock ink's fallback is `clearTerminal +
        // fullStaticOutput + output` — erasing the ENTIRE scrollback buffer
        // and re-dumping every static byte ever printed, on EVERY frame. With
        // a long transcript that is megabytes per frame: the scrollbar jumps
        // to the top, the UI flickers, and native scrolling becomes
        // impossible. Instead keep the frame bottom-anchored: trim to what
        // fits (rows - 1) and let the normal diff path write it. Scrollback
        // is never cleared, the transcript is never re-dumped, and the newest
        // rows (live tail, input, status bar) stay visible.
        const maxLiveRows = Math.max(1, (this.options.stdout.rows || 24) - 1);
        const liveHeightBeforeTrim = outputHeight;
        if (outputHeight >= (this.options.stdout.rows || 24)) {
            // `output` is newline-terminated per row WITHOUT a trailing blank
            // line (log-update appends its own), so split and re-join verbatim.
            output = output.split('\n').slice(-maxLiveRows).join('\n');
            outputHeight = maxLiveRows;
        }
        // Hardware cursor (Cosmic Stack patch): resolve AFTER the trim so the row
        // is relative to the rows actually written.
        const cursor = this.resolveCursor(liveHeightBeforeTrim - outputHeight);
        // If <Static> output isn't empty, it means new children have been added to it
        const hasStaticOutput = staticOutput && staticOutput !== '\n';
        if (this.options.debug) {
            if (hasStaticOutput) {
                this.fullStaticOutput += staticOutput;
            }
            this.options.stdout.write(this.fullStaticOutput + output);
            return;
        }
        if (isInCi) {
            if (hasStaticOutput) {
                this.options.stdout.write(staticOutput);
            }
            this.lastOutput = output;
            return;
        }
        if (hasStaticOutput) {
            this.fullStaticOutput += staticOutput;
        }
        if (outputHeight >= this.options.stdout.rows) {
            this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            this.lastOutput = output;
            return;
        }
        // To ensure static output is cleanly rendered before main output, clear main output first
        if (hasStaticOutput) {
            this.log.clear();
            this.options.stdout.write(staticOutput);
            this.log(output, cursor);
        }
        if (!hasStaticOutput && (output !== this.lastOutput || !sameCursor(cursor, this.lastCursor))) {
            this.throttledLog(output, cursor);
        }
        this.lastOutput = output;
        this.lastCursor = cursor;
    };
    render(node) {
        const tree = (React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, exitOnCtrlC: this.options.exitOnCtrlC, onExit: this.unmount }, node));
        reconciler.updateContainer(tree, this.container, null, noop);
    }
    writeToStdout(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stdout.write(data);
            return;
        }
        this.log.clear();
        this.options.stdout.write(data);
        this.log(this.lastOutput, this.lastCursor);
    }
    writeToStderr(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stderr.write(data);
            this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stderr.write(data);
            return;
        }
        this.log.clear();
        this.options.stderr.write(data);
        this.log(this.lastOutput, this.lastCursor);
    }
    // eslint-disable-next-line @typescript-eslint/ban-types
    unmount(error) {
        if (this.isUnmounted) {
            return;
        }
        this.calculateLayout();
        this.onRender();
        this.unsubscribeExit();
        if (typeof this.restoreConsole === 'function') {
            this.restoreConsole();
        }
        if (typeof this.unsubscribeResize === 'function') {
            this.unsubscribeResize();
        }
        // CIs don't handle erasing ansi escapes well, so it's better to
        // only render last frame of non-static output
        if (isInCi) {
            this.options.stdout.write(this.lastOutput + '\n');
        }
        else if (!this.options.debug) {
            this.log.done();
        }
        this.isUnmounted = true;
        reconciler.updateContainer(null, this.container, null, noop);
        instances.delete(this.options.stdout);
        if (error instanceof Error) {
            this.rejectExitPromise(error);
        }
        else {
            this.resolveExitPromise();
        }
    }
    async waitUntilExit() {
        this.exitPromise ||= new Promise((resolve, reject) => {
            this.resolveExitPromise = resolve;
            this.rejectExitPromise = reject;
        });
        return this.exitPromise;
    }
    clear() {
        if (!isInCi && !this.options.debug) {
            this.log.clear();
        }
    }
    patchConsole() {
        if (this.options.debug) {
            return;
        }
        this.restoreConsole = patchConsole((stream, data) => {
            if (stream === 'stdout') {
                this.writeToStdout(data);
            }
            if (stream === 'stderr') {
                const isReactMessage = data.startsWith('The above error occurred');
                if (!isReactMessage) {
                    this.writeToStderr(data);
                }
            }
        });
    }
}
