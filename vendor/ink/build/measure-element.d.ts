import { type DOMElement } from './dom.js';
type Output = {
    /**
    Horizontal position (0-based column) within the live layout region.
    */
    x: number;
    /**
    Vertical position (0-based row) within the live layout region.
    */
    y: number;
    /**
    Element width.
    */
    width: number;
    /**
    Element height.
    */
    height: number;
    /**
    Element width excluding borders.
    */
    clientWidth: number;
    /**
    Element height excluding borders.
    */
    clientHeight: number;
};
/**
Measure the layout metrics of a particular `<Box>` element.
Returns an object with `x`, `y`, `width`, `height`, `clientWidth` and `clientHeight` properties.

`x` and `y` are the element's position within the live layout region, computed by walking up the layout tree and accumulating each ancestor's offset. These are layout-tree coordinates, not terminal viewport coordinates. To compare them with mouse events, convert the event coordinates using the live region's viewport position. This is necessary even in alternate-screen mode when output, such as `<Static>` content, appears above the live region. These are layout coordinates and do not include any `contentOffsetX`/`contentOffsetY` applied by an ancestor, so hit-testing inside a scrolled container has to subtract those offsets too.

`clientWidth` and `clientHeight` are the element's dimensions excluding borders, which is the amount of space its content can occupy. To build a scrollable view, measure the content wrapper separately and clamp the offset with `content.height - viewport.clientHeight`, together with the `contentOffsetX`/`contentOffsetY` props. That bound assumes an unpadded viewport, since `clientWidth`/`clientHeight` exclude borders but not padding; put padding on the content wrapper instead.

Note: `measureElement()` returns zeros for all properties when called during render (before layout is calculated). Call it from post-render code, such as `useEffect`, `useLayoutEffect`, input handlers, or timer callbacks. When content changes, pass the relevant dependency to your effect so it re-measures after each update.
*/
declare const measureElement: (node: DOMElement) => Output;
export default measureElement;
export type { Output as ElementMetrics };
