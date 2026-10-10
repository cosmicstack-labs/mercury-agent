import React, { forwardRef, use } from 'react';
import { AccessibilityContext } from './AccessibilityContext.js';
import { BackgroundContext } from './BackgroundContext.js';
/**
`<Box>` is an essential Ink component to build your layout. It's like `<div style="display: flex">` in the browser.
*/
// eslint-disable-next-line @eslint-react/no-forward-ref -- Removing `forwardRef` changes the public component type of `Box`.
const Box = forwardRef(({ children, backgroundColor, flexWrap = 'nowrap', flexDirection = 'row', 'aria-label': ariaLabel, 'aria-hidden': ariaHidden, 'aria-role': role, 'aria-state': ariaState, ...style }, ref) => {
    const { isScreenReaderEnabled } = use(AccessibilityContext);
    const inheritedBackgroundColor = use(BackgroundContext);
    if (isScreenReaderEnabled && ariaHidden) {
        return null;
    }
    const effectiveBackgroundColor = 
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Empty background colors inherit from the parent too.
    backgroundColor || inheritedBackgroundColor;
    const boxElement = (React.createElement("ink-box", { ref: ref, style: {
            flexWrap,
            flexDirection,
            flexGrow: 0,
            flexShrink: 1,
            ...style,
            backgroundColor,
            overflowX: style.overflowX ?? style.overflow ?? 'visible',
            overflowY: style.overflowY ?? style.overflow ?? 'visible',
        }, internal_accessibility: {
            role,
            state: ariaState,
        } }, isScreenReaderEnabled && Boolean(ariaLabel) ? (React.createElement("ink-text", null, ariaLabel)) : (children)));
    // Provide this Box's background color or its inherited color to children via context
    return (React.createElement(BackgroundContext, { value: effectiveBackgroundColor }, boxElement));
});
Box.displayName = 'Box';
export default Box;
