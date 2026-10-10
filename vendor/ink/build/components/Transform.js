import React, { use } from 'react';
import { AccessibilityContext } from './AccessibilityContext.js';
/**
Transform a string representation of React components before they're written to output. For example, you might want to apply a gradient to text, add a clickable link, or create some text effects. These use cases can't accept React nodes as input; they expect a string. That's what the <Transform> component does: it gives you an output string of its child components and lets you transform it in any way.
*/
export default function Transform({ children, transform, accessibilityLabel, }) {
    const { isScreenReaderEnabled } = use(AccessibilityContext);
    const childrenOrAccessibilityLabel = isScreenReaderEnabled
        ? (accessibilityLabel ?? children)
        : children;
    if (childrenOrAccessibilityLabel === undefined ||
        childrenOrAccessibilityLabel === null) {
        return null;
    }
    return (React.createElement("ink-text", { style: { flexGrow: 0, flexShrink: 1, flexDirection: 'row' }, internal_transform: isScreenReaderEnabled ? undefined : transform }, childrenOrAccessibilityLabel));
}
