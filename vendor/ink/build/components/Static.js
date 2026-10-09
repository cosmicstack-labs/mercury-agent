import React, { useMemo, useState, useLayoutEffect, useRef } from 'react';
/**
 * `<Static>` component permanently renders its output above everything else.
 * It's useful for displaying activity like completed tasks or logs - things that
 * are not changing after they're rendered (hence the name "Static").
 *
 * It's preferred to use `<Static>` for use cases like these, when you can't know
 * or control the amount of items that need to be rendered.
 *
 * For example, [Tap](https://github.com/tapjs/node-tap) uses `<Static>` to display
 * a list of completed tests. [Gatsby](https://github.com/gatsbyjs/gatsby) uses it
 * to display a list of generated pages, while still displaying a live progress bar.
 *
 * Patched (Cosmic Stack): supports an optional `itemKey` identity function.
 * The built-in positional index assumes `items` only ever appends — a caller
 * that keeps the array bounded by dropping the oldest items (a sliding
 * window) breaks it: `items.slice(index)` returns nothing, new items are
 * never rendered, and every commit unmounts the whole subtree. With
 * `itemKey`, each item is tracked by identity and rendered exactly once per
 * instance lifetime, so bounded sliding windows are safe.
 */
export default function Static(props) {
    const { items, children: render, style: customStyle, itemKey } = props;
    const [index, setIndex] = useState(0);
    // Identity of items already written to the terminal in this instance.
    // Only used when `itemKey` is provided.
    const committedKeys = useRef(null);
    // Bumped after committing keys so the memo recomputes and the rendered
    // children are unmounted — the positional path does this via setIndex.
    // Without it, committed children stay mounted and the renderer keeps
    // re-printing them into the terminal on EVERY subsequent render (each
    // pass re-emits `staticOutput` while the nodes are still attached).
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
