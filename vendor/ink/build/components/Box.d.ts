import React from 'react';
import { type Except } from 'type-fest';
import { type Styles } from '../styles.js';
import { type DOMElement } from '../dom.js';
export type Props = Except<Styles, 'textWrap'> & {
    /**
    A label for the element for screen readers.
    */
    readonly 'aria-label'?: string;
    /**
    Hide the element from screen readers.
    */
    readonly 'aria-hidden'?: boolean;
    /**
    The role of the element.
    */
    readonly 'aria-role'?: 'button' | 'checkbox' | 'combobox' | 'list' | 'listbox' | 'listitem' | 'menu' | 'menuitem' | 'option' | 'progressbar' | 'radio' | 'radiogroup' | 'tab' | 'tablist' | 'table' | 'textbox' | 'timer' | 'toolbar';
    /**
    The state of the element.
    */
    readonly 'aria-state'?: {
        readonly busy?: boolean;
        readonly checked?: boolean;
        readonly disabled?: boolean;
        readonly expanded?: boolean;
        readonly multiline?: boolean;
        readonly multiselectable?: boolean;
        readonly readonly?: boolean;
        readonly required?: boolean;
        readonly selected?: boolean;
    };
};
/**
`<Box>` is an essential Ink component to build your layout. It's like `<div style="display: flex">` in the browser.
*/
declare const Box: React.ForwardRefExoticComponent<{
    readonly position?: "absolute" | "relative" | "static" | undefined;
    readonly top?: number | string | undefined;
    readonly right?: number | string | undefined;
    readonly bottom?: number | string | undefined;
    readonly left?: number | string | undefined;
    readonly columnGap?: number | undefined;
    readonly rowGap?: number | undefined;
    readonly gap?: number | undefined;
    readonly margin?: number | undefined;
    readonly marginX?: number | undefined;
    readonly marginY?: number | undefined;
    readonly marginTop?: number | undefined;
    readonly marginBottom?: number | undefined;
    readonly marginLeft?: number | undefined;
    readonly marginRight?: number | undefined;
    readonly padding?: number | undefined;
    readonly paddingX?: number | undefined;
    readonly paddingY?: number | undefined;
    readonly paddingTop?: number | undefined;
    readonly paddingBottom?: number | undefined;
    readonly paddingLeft?: number | undefined;
    readonly paddingRight?: number | undefined;
    readonly flexGrow?: number | undefined;
    readonly flexShrink?: number | undefined;
    readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse" | undefined;
    readonly flexBasis?: number | string | undefined;
    readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse" | undefined;
    readonly alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline" | undefined;
    readonly alignSelf?: "flex-start" | "center" | "flex-end" | "auto" | "stretch" | "baseline" | undefined;
    readonly alignContent?: "flex-start" | "flex-end" | "center" | "stretch" | "space-between" | "space-around" | "space-evenly" | undefined;
    readonly justifyContent?: "flex-start" | "flex-end" | "space-between" | "space-around" | "space-evenly" | "center" | undefined;
    readonly width?: number | string | undefined;
    readonly height?: number | string | undefined;
    readonly minWidth?: number | undefined;
    readonly minHeight?: number | string | undefined;
    readonly maxWidth?: number | undefined;
    readonly maxHeight?: number | string | undefined;
    readonly aspectRatio?: number | undefined;
    readonly display?: "flex" | "none" | undefined;
    readonly borderStyle?: (keyof import("cli-boxes").Boxes | import("cli-boxes").BoxStyle) | undefined;
    readonly borderTop?: boolean | undefined;
    readonly borderBottom?: boolean | undefined;
    readonly borderLeft?: boolean | undefined;
    readonly borderRight?: boolean | undefined;
    readonly borderColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderTopColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderBottomColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderLeftColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderRightColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderDimColor?: boolean | undefined;
    readonly borderTopDimColor?: boolean | undefined;
    readonly borderBottomDimColor?: boolean | undefined;
    readonly borderLeftDimColor?: boolean | undefined;
    readonly borderRightDimColor?: boolean | undefined;
    readonly borderBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderTopBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderBottomBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderLeftBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderRightBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly overflow?: "visible" | "hidden" | undefined;
    readonly overflowX?: "visible" | "hidden" | undefined;
    readonly overflowY?: "visible" | "hidden" | undefined;
    readonly contentOffsetX?: number | undefined;
    readonly contentOffsetY?: number | undefined;
    readonly backgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
} & {
    /**
    A label for the element for screen readers.
    */
    readonly 'aria-label'?: string;
    /**
    Hide the element from screen readers.
    */
    readonly 'aria-hidden'?: boolean;
    /**
    The role of the element.
    */
    readonly 'aria-role'?: "button" | "checkbox" | "combobox" | "list" | "listbox" | "listitem" | "menu" | "menuitem" | "option" | "progressbar" | "radio" | "radiogroup" | "tab" | "tablist" | "table" | "textbox" | "timer" | "toolbar";
    /**
    The state of the element.
    */
    readonly 'aria-state'?: {
        readonly busy?: boolean;
        readonly checked?: boolean;
        readonly disabled?: boolean;
        readonly expanded?: boolean;
        readonly multiline?: boolean;
        readonly multiselectable?: boolean;
        readonly readonly?: boolean;
        readonly required?: boolean;
        readonly selected?: boolean;
    };
} & {
    children?: React.ReactNode | undefined;
} & React.RefAttributes<DOMElement>>;
export default Box;
