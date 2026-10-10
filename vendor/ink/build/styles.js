import Yoga from 'yoga-layout';
const positionEdges = [
    ['top', Yoga.EDGE_TOP],
    ['right', Yoga.EDGE_RIGHT],
    ['bottom', Yoga.EDGE_BOTTOM],
    ['left', Yoga.EDGE_LEFT],
];
const applyPositionStyles = (node, style) => {
    if ('position' in style) {
        let positionType = Yoga.POSITION_TYPE_RELATIVE;
        if (style.position === 'absolute') {
            positionType = Yoga.POSITION_TYPE_ABSOLUTE;
        }
        else if (style.position === 'static') {
            positionType = Yoga.POSITION_TYPE_STATIC;
        }
        node.setPositionType(positionType);
    }
    for (const [property, edge] of positionEdges) {
        if (!Object.hasOwn(style, property)) {
            continue;
        }
        const value = style[property];
        if (typeof value === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setPositionPercent(edge, Number.parseFloat(value));
            continue;
        }
        node.setPosition(edge, value);
    }
};
const applyMarginStyles = (node, style) => {
    if ('margin' in style) {
        node.setMargin(Yoga.EDGE_ALL, style.margin ?? 0);
    }
    if ('marginX' in style) {
        node.setMargin(Yoga.EDGE_HORIZONTAL, style.marginX);
    }
    if ('marginY' in style) {
        node.setMargin(Yoga.EDGE_VERTICAL, style.marginY);
    }
    if ('marginLeft' in style) {
        node.setMargin(Yoga.EDGE_START, style.marginLeft);
    }
    if ('marginRight' in style) {
        node.setMargin(Yoga.EDGE_END, style.marginRight);
    }
    if ('marginTop' in style) {
        node.setMargin(Yoga.EDGE_TOP, style.marginTop);
    }
    if ('marginBottom' in style) {
        node.setMargin(Yoga.EDGE_BOTTOM, style.marginBottom);
    }
};
const applyPaddingStyles = (node, style) => {
    if ('padding' in style) {
        node.setPadding(Yoga.EDGE_ALL, style.padding ?? 0);
    }
    if ('paddingX' in style) {
        node.setPadding(Yoga.EDGE_HORIZONTAL, style.paddingX);
    }
    if ('paddingY' in style) {
        node.setPadding(Yoga.EDGE_VERTICAL, style.paddingY);
    }
    if ('paddingLeft' in style) {
        node.setPadding(Yoga.EDGE_LEFT, style.paddingLeft);
    }
    if ('paddingRight' in style) {
        node.setPadding(Yoga.EDGE_RIGHT, style.paddingRight);
    }
    if ('paddingTop' in style) {
        node.setPadding(Yoga.EDGE_TOP, style.paddingTop);
    }
    if ('paddingBottom' in style) {
        node.setPadding(Yoga.EDGE_BOTTOM, style.paddingBottom);
    }
};
const flexWrapValues = new Map([
    ['nowrap', Yoga.WRAP_NO_WRAP],
    ['wrap', Yoga.WRAP_WRAP],
    ['wrap-reverse', Yoga.WRAP_WRAP_REVERSE],
]);
const flexDirectionValues = new Map([
    ['row', Yoga.FLEX_DIRECTION_ROW],
    ['row-reverse', Yoga.FLEX_DIRECTION_ROW_REVERSE],
    ['column', Yoga.FLEX_DIRECTION_COLUMN],
    ['column-reverse', Yoga.FLEX_DIRECTION_COLUMN_REVERSE],
]);
const alignItemsValues = new Map([
    ['stretch', Yoga.ALIGN_STRETCH],
    ['flex-start', Yoga.ALIGN_FLEX_START],
    ['center', Yoga.ALIGN_CENTER],
    ['flex-end', Yoga.ALIGN_FLEX_END],
    ['baseline', Yoga.ALIGN_BASELINE],
]);
const alignSelfValues = new Map([
    ['auto', Yoga.ALIGN_AUTO],
    ['flex-start', Yoga.ALIGN_FLEX_START],
    ['center', Yoga.ALIGN_CENTER],
    ['flex-end', Yoga.ALIGN_FLEX_END],
    ['stretch', Yoga.ALIGN_STRETCH],
    ['baseline', Yoga.ALIGN_BASELINE],
]);
const alignContentValues = new Map([
    ['flex-start', Yoga.ALIGN_FLEX_START],
    ['center', Yoga.ALIGN_CENTER],
    ['flex-end', Yoga.ALIGN_FLEX_END],
    ['space-between', Yoga.ALIGN_SPACE_BETWEEN],
    ['space-around', Yoga.ALIGN_SPACE_AROUND],
    ['space-evenly', Yoga.ALIGN_SPACE_EVENLY],
    ['stretch', Yoga.ALIGN_STRETCH],
]);
const justifyContentValues = new Map([
    ['flex-start', Yoga.JUSTIFY_FLEX_START],
    ['center', Yoga.JUSTIFY_CENTER],
    ['flex-end', Yoga.JUSTIFY_FLEX_END],
    ['space-between', Yoga.JUSTIFY_SPACE_BETWEEN],
    ['space-around', Yoga.JUSTIFY_SPACE_AROUND],
    ['space-evenly', Yoga.JUSTIFY_SPACE_EVENLY],
]);
const applyFlexStyles = (node, style) => {
    if ('flexGrow' in style) {
        node.setFlexGrow(style.flexGrow ?? 0);
    }
    if ('flexShrink' in style) {
        node.setFlexShrink(typeof style.flexShrink === 'number' ? style.flexShrink : 1);
    }
    if ('flexWrap' in style) {
        const flexWrap = flexWrapValues.get(style.flexWrap);
        if (flexWrap !== undefined) {
            node.setFlexWrap(flexWrap);
        }
    }
    if ('flexDirection' in style) {
        const flexDirection = flexDirectionValues.get(style.flexDirection);
        if (flexDirection !== undefined) {
            node.setFlexDirection(flexDirection);
        }
    }
    if ('flexBasis' in style) {
        if (typeof style.flexBasis === 'number') {
            node.setFlexBasis(style.flexBasis);
        }
        else if (typeof style.flexBasis === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setFlexBasisPercent(Number.parseFloat(style.flexBasis));
        }
        else {
            node.setFlexBasisAuto();
        }
    }
    if ('alignItems' in style) {
        const alignItems = 
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- JavaScript callers pass `null` or `false` (for example `condition && 'center'`), and any falsy value means the default.
        style.alignItems
            ? alignItemsValues.get(style.alignItems)
            : Yoga.ALIGN_STRETCH;
        if (alignItems !== undefined) {
            node.setAlignItems(alignItems);
        }
    }
    if ('alignSelf' in style) {
        const alignSelf = 
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- JavaScript callers pass `null` or `false` (for example `condition && 'center'`), and any falsy value means the default.
        style.alignSelf ? alignSelfValues.get(style.alignSelf) : Yoga.ALIGN_AUTO;
        if (alignSelf !== undefined) {
            node.setAlignSelf(alignSelf);
        }
    }
    if ('alignContent' in style) {
        // Keep wrapped lines top-packed by default; stretch can add surprising empty rows in fixed-height boxes.
        const alignContent = 
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- JavaScript callers pass `null` or `false` (for example `condition && 'center'`), and any falsy value means the default.
        style.alignContent
            ? alignContentValues.get(style.alignContent)
            : Yoga.ALIGN_FLEX_START;
        if (alignContent !== undefined) {
            node.setAlignContent(alignContent);
        }
    }
    if (!('justifyContent' in style)) {
        return;
    }
    const justifyContent = 
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- JavaScript callers pass `null` or `false` (for example `condition && 'center'`), and any falsy value means the default.
    style.justifyContent
        ? justifyContentValues.get(style.justifyContent)
        : Yoga.JUSTIFY_FLEX_START;
    if (justifyContent !== undefined) {
        node.setJustifyContent(justifyContent);
    }
};
const applyDimensionStyles = (node, style) => {
    if ('width' in style) {
        if (typeof style.width === 'number') {
            node.setWidth(style.width);
        }
        else if (typeof style.width === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setWidthPercent(Number.parseFloat(style.width));
        }
        else {
            node.setWidthAuto();
        }
    }
    if ('height' in style) {
        if (typeof style.height === 'number') {
            node.setHeight(style.height);
        }
        else if (typeof style.height === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setHeightPercent(Number.parseFloat(style.height));
        }
        else {
            node.setHeightAuto();
        }
    }
    if ('minWidth' in style) {
        node.setMinWidth(style.minWidth ?? 0);
    }
    if ('minHeight' in style) {
        if (typeof style.minHeight === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setMinHeightPercent(Number.parseFloat(style.minHeight));
        }
        else {
            node.setMinHeight(style.minHeight ?? 0);
        }
    }
    if ('maxWidth' in style) {
        node.setMaxWidth(style.maxWidth);
    }
    if ('maxHeight' in style) {
        if (typeof style.maxHeight === 'string') {
            // eslint-disable-next-line unicorn/prefer-number-coercion -- Percentage strings like `'50%'` need `Number.parseFloat()`, because `Number('50%')` is `NaN`.
            node.setMaxHeightPercent(Number.parseFloat(style.maxHeight));
        }
        else {
            node.setMaxHeight(style.maxHeight);
        }
    }
    if ('aspectRatio' in style) {
        node.setAspectRatio(style.aspectRatio);
    }
};
const applyDisplayStyles = (node, style) => {
    if ('display' in style) {
        node.setDisplay(style.display === 'none' ? Yoga.DISPLAY_NONE : Yoga.DISPLAY_FLEX);
    }
};
const applyBorderStyles = (node, style, currentStyle) => {
    const hasBorderChanges = 'borderStyle' in style ||
        'borderTop' in style ||
        'borderBottom' in style ||
        'borderLeft' in style ||
        'borderRight' in style;
    if (!hasBorderChanges) {
        return;
    }
    const hasBorder = Boolean(currentStyle.borderStyle);
    const borderWidth = hasBorder ? 1 : 0;
    node.setBorder(Yoga.EDGE_TOP, currentStyle.borderTop === false ? 0 : borderWidth);
    node.setBorder(Yoga.EDGE_BOTTOM, currentStyle.borderBottom === false ? 0 : borderWidth);
    node.setBorder(Yoga.EDGE_LEFT, currentStyle.borderLeft === false ? 0 : borderWidth);
    node.setBorder(Yoga.EDGE_RIGHT, currentStyle.borderRight === false ? 0 : borderWidth);
};
const applyGapStyles = (node, style) => {
    if ('gap' in style) {
        node.setGap(Yoga.GUTTER_ALL, style.gap ?? 0);
    }
    if ('columnGap' in style) {
        node.setGap(Yoga.GUTTER_COLUMN, style.columnGap);
    }
    if ('rowGap' in style) {
        node.setGap(Yoga.GUTTER_ROW, style.rowGap);
    }
};
const styles = (node, style = {}, currentStyle = style) => {
    applyPositionStyles(node, style);
    applyMarginStyles(node, style);
    applyPaddingStyles(node, style);
    applyFlexStyles(node, style);
    applyDimensionStyles(node, style);
    applyDisplayStyles(node, style);
    applyBorderStyles(node, style, currentStyle);
    applyGapStyles(node, style);
};
export default styles;
