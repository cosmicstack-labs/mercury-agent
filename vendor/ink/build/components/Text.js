import React, { use } from 'react';
import chalk from 'chalk';
import colorize from '../colorize.js';
import { AccessibilityContext } from './AccessibilityContext.js';
import { BackgroundContext } from './BackgroundContext.js';
/**
This component can display text and change its style to make it bold, underlined, italic, or strikethrough.
*/
export default function Text({ color, backgroundColor, dimColor = false, bold = false, italic = false, underline = false, strikethrough = false, inverse = false, wrap = 'wrap', children, 'aria-label': ariaLabel, 'aria-hidden': ariaHidden = false, }) {
    const { isScreenReaderEnabled } = use(AccessibilityContext);
    const inheritedBackgroundColor = use(BackgroundContext);
    // Use explicit backgroundColor if provided, otherwise inherit from the nearest parent Text or Box.
    const effectiveBackgroundColor = backgroundColor ?? inheritedBackgroundColor;
    const childrenOrAriaLabel = isScreenReaderEnabled && Boolean(ariaLabel) ? ariaLabel : children;
    if (childrenOrAriaLabel === undefined ||
        childrenOrAriaLabel === null ||
        (isScreenReaderEnabled && ariaHidden)) {
        return null;
    }
    const transform = (text) => {
        if (dimColor) {
            text = chalk.dim(text);
        }
        // `colorize` returns the text unchanged when the color is unset.
        text = colorize(text, color, 'foreground');
        text = colorize(text, effectiveBackgroundColor, 'background');
        if (bold) {
            text = chalk.bold(text);
        }
        if (italic) {
            text = chalk.italic(text);
        }
        if (underline) {
            text = chalk.underline(text);
        }
        if (strikethrough) {
            text = chalk.strikethrough(text);
        }
        if (inverse) {
            text = chalk.inverse(text);
        }
        return text;
    };
    return (React.createElement(BackgroundContext, { value: effectiveBackgroundColor },
        React.createElement("ink-text", { style: {
                flexGrow: 0,
                flexShrink: 1,
                flexDirection: 'row',
                textWrap: wrap,
            }, internal_transform: isScreenReaderEnabled ? undefined : transform }, childrenOrAriaLabel)));
}
