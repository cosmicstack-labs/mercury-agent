import React, { useMemo, useState, useLayoutEffect, useRef, use, } from 'react';
import { BackgroundContext } from './BackgroundContext.js';
/**
`<Static>` component permanently renders its output above everything else. It's useful for displaying activity like completed tasks or logs—things that don't change after they're rendered (hence the name "Static").

It's preferred to use `<Static>` for use cases like these when you can't know or control the number of items that need to be rendered.

For example, [Tap](https://github.com/tapjs/node-tap) uses `<Static>` to display a list of completed tests. [Gatsby](https://github.com/gatsbyjs/gatsby) uses it to display a list of generated pages while still displaying a live progress bar.
*/
export default function Static(props) {
    const { items, children: render, style: customStyle, itemKey } = props;
    const [index, setIndex] = useState(0);
    // Static itemKey (Cosmic Stack patch): with `itemKey`, items are tracked by identity and
    // each is written exactly once per instance, so a caller may keep `items`
    // bounded by dropping the oldest (a sliding window). The positional index
    // below assumes append-only: once old items drop off, `items.slice(index)`
    // returns nothing and new items are never written.
    const committedKeys = useRef(null);
    // Bumped after committing keys so the memo recomputes and the written
    // children unmount (the positional path does this via setIndex). Without
    // it they stay mounted and are re-emitted as static output every render.
    const [commitTick, setCommitTick] = useState(0);
    const inheritedBackgroundColor = use(BackgroundContext);
    const effectiveBackgroundColor = 
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Empty background colors inherit from the parent too.
    customStyle?.backgroundColor || inheritedBackgroundColor;
    const itemsToRender = useMemo(() => {
        if (typeof itemKey === 'function') {
            committedKeys.current ??= new Set();
            const committed = committedKeys.current;
            return items.filter((item) => {
                const key = itemKey(item);
                return key !== undefined && !committed.has(key);
            });
        }
        return items.slice(index);
    }, [items, index, itemKey, commitTick]);
    useLayoutEffect(() => {
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
    }, [itemsToRender, itemKey, items.length]);
    const children = itemsToRender.map((item, itemIndex) => render(item, index + itemIndex));
    const style = useMemo(() => ({
        position: 'absolute',
        flexDirection: 'column',
        ...customStyle,
        display: itemsToRender.length > 0 ? customStyle?.display : 'none',
    }), [customStyle, itemsToRender.length]);
    return (React.createElement(BackgroundContext, { value: effectiveBackgroundColor },
        React.createElement("ink-box", { internal_static: true, style: style }, children)));
}
