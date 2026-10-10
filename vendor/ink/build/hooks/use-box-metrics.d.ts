import { type RefObject } from 'react';
import { type DOMElement } from '../dom.js';
/**
Metrics of a box element.

All positions are relative to the element's parent.
*/
export type BoxMetrics = {
    /**
    Element width.
    */
    readonly width: number;
    /**
    Element height.
    */
    readonly height: number;
    /**
    Distance from the left edge of the parent. These are layout coordinates and do not include any `contentOffsetX`/`contentOffsetY` applied by an ancestor, so hit-testing inside a scrolled container has to subtract those offsets too.
    */
    readonly left: number;
    /**
    Distance from the top edge of the parent. These are layout coordinates and do not include any `contentOffsetX`/`contentOffsetY` applied by an ancestor, so hit-testing inside a scrolled container has to subtract those offsets too.
    */
    readonly top: number;
    /**
    Element width excluding borders.
    */
    readonly clientWidth: number;
    /**
    Element height excluding borders.
    */
    readonly clientHeight: number;
};
export type UseBoxMetricsResult = BoxMetrics & {
    /**
    Whether the currently tracked element has been measured in the latest layout pass.
    */
    readonly hasMeasured: boolean;
};
/**
A React hook that returns the current layout metrics for a tracked box element.
It updates when layout changes (for example terminal resize, sibling/content changes, or position changes).

The hook returns zeros for all metrics until the first layout pass completes. It also returns zeros when the tracked ref is detached.

Use `hasMeasured` to detect when the currently tracked element has been measured.

@example
```tsx
import {useRef} from 'react';
import {Box, Text, useBoxMetrics} from 'ink';

const Example = () => {
    const ref = useRef(null);
    const {width, height, left, top, hasMeasured} = useBoxMetrics(ref);
    return (
        <Box ref={ref}>
            <Text>
                {hasMeasured ? `${width}x${height} at ${left},${top}` : 'Measuring...'}
            </Text>
        </Box>
    );
};
```
*/
declare const useBoxMetrics: (ref: RefObject<DOMElement | null>) => UseBoxMetricsResult;
export default useBoxMetrics;
