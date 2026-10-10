import Yoga from 'yoga-layout';
const emptyOutput = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
};
/**
Measure the layout metrics of a particular `<Box>` element.
Returns an object with `x`, `y`, `width`, `height`, `clientWidth` and `clientHeight` properties.

`x` and `y` are the element's position within the live layout region, computed by walking up the layout tree and accumulating each ancestor's offset. These are layout-tree coordinates, not terminal viewport coordinates. To compare them with mouse events, convert the event coordinates using the live region's viewport position. This is necessary even in alternate-screen mode when output, such as `<Static>` content, appears above the live region. These are layout coordinates and do not include any `contentOffsetX`/`contentOffsetY` applied by an ancestor, so hit-testing inside a scrolled container has to subtract those offsets too.

`clientWidth` and `clientHeight` are the element's dimensions excluding borders, which is the amount of space its content can occupy. To build a scrollable view, measure the content wrapper separately and clamp the offset with `content.height - viewport.clientHeight`, together with the `contentOffsetX`/`contentOffsetY` props. That bound assumes an unpadded viewport, since `clientWidth`/`clientHeight` exclude borders but not padding; put padding on the content wrapper instead.

Note: `measureElement()` returns zeros for all properties when called during render (before layout is calculated). Call it from post-render code, such as `useEffect`, `useLayoutEffect`, input handlers, or timer callbacks. When content changes, pass the relevant dependency to your effect so it re-measures after each update.
*/
const measureElement = (node) => {
    const { yogaNode } = node;
    if (!yogaNode) {
        return emptyOutput;
    }
    let x = yogaNode.getComputedLeft();
    let y = yogaNode.getComputedTop();
    let current = node.parentNode;
    while (current) {
        if (current.yogaNode) {
            x += current.yogaNode.getComputedLeft();
            y += current.yogaNode.getComputedTop();
        }
        current = current.parentNode;
    }
    const width = yogaNode.getComputedWidth();
    const height = yogaNode.getComputedHeight();
    const borderLeft = yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
    const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
    const clientWidth = width - borderLeft - yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
    const clientHeight = height - borderTop - yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
        x,
        y,
        width,
        height,
        clientWidth,
        clientHeight,
    };
};
export default measureElement;
