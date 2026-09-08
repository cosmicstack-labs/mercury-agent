/**
 * Ensure the bundled ink fixes are applied to the installed ink.
 * Idempotent: checks for the fix markers first, then edits the two files
 * DIRECTLY — no patch-package dependency (patch-package itself failed on
 * Termux/npm-11 containers: `sh: 1: patch-package: not found`).
 *
 * What it applies (mirrors patches/ink+5.2.1.patch):
 *   1. reconciler.js — freed-Yoga-node hygiene: null every JS reference in
 *      removed subtrees after freeRecursive, and clear the root's cached
 *      staticNode when the removed subtree contains it. Also guards ink's
 *      `#text` nodes (no childNodes array) in the traversal.
 *   2. Static.js — `itemKey` identity dedup so bounded sliding item windows
 *      are safe (the positional index assumes append-only), plus the
 *      commitTick re-render that unmounts written children (ink's renderer
 *      re-prints still-mounted static children on every render).
 *   3. Static.d.ts — the `itemKey` type.
 *
 * Loud on failure: a silent skip is never acceptable for a crash fix.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const inkDir = path.join(root, 'node_modules', 'ink', 'build');
const reconcilerPath = path.join(inkDir, 'reconciler.js');
const staticJsPath = path.join(inkDir, 'components', 'Static.js');
const staticDtsPath = path.join(inkDir, 'components', 'Static.d.ts');

function isPatched() {
  try {
    const reconciler = fs.readFileSync(reconcilerPath, 'utf8');
    const staticComponent = fs.readFileSync(staticJsPath, 'utf8');
    return reconciler.includes('clearYogaRefs')
      && reconciler.includes('Array.isArray(node.childNodes)')
      && reconciler.includes('rootNode.staticNode = undefined')
      && staticComponent.includes('itemKey')
      && staticComponent.includes('setCommitTick');
  } catch {
    return false;
  }
}

function applyReconcilerFix() {
  let s = fs.readFileSync(reconcilerPath, 'utf8');
  if (s.includes('clearYogaRefs')) return true;

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
  fs.writeFileSync(reconcilerPath, s);
  return true;
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

function applyStaticFix() {
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

function apply() {
  if (isPatched()) return { ok: true, applied: false };
  if (!fs.existsSync(reconcilerPath)) {
    return { ok: false, applied: false, error: 'node_modules/ink not installed' };
  }
  try {
    const reconcilerOk = applyReconcilerFix();
    const staticOk = applyStaticFix();
    if (!reconcilerOk) {
      return { ok: false, applied: true, error: 'reconciler.js no longer matches the expected ink 5.2.1 shape — patch anchors not found' };
    }
    if (!staticOk) {
      return { ok: false, applied: true, error: 'Static.js could not be rewritten' };
    }
  } catch (err) {
    return { ok: false, applied: true, error: err.message };
  }
  if (!isPatched()) {
    return { ok: false, applied: true, error: 'edits ran but the fix markers are still missing' };
  }
  return { ok: true, applied: true };
}

module.exports = { isPatched, apply };

if (require.main === module) {
  const result = apply();
  if (result.ok && result.applied) {
    console.log('  ✓ ink fixes applied (Yoga WASM crash hygiene + Static identity dedup)');
  } else if (result.ok) {
    console.log('  ✓ ink fixes already applied');
  } else {
    console.error('  ⚠ INK FIXES NOT APPLIED — the Yoga WASM crash class is UNPATCHED in this install.');
    console.error(`    Reason: ${result.error}`);
    console.error('    Fix: reinstall dependencies (npm install) and re-run the build.');
  }
}