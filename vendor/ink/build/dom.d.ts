import { type Node as YogaNode } from 'yoga-layout';
import { type Styles } from './styles.js';
import { type OutputTransformer } from './render-node-to-output.js';
type InkNode = {
    parentNode: DOMElement | undefined;
    yogaNode?: YogaNode;
    internal_static?: boolean;
    style: Styles;
};
type LayoutListener = () => void;
export type TextName = '#text';
export type ElementNames = 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text';
export type NodeNames = ElementNames | TextName;
export type DOMElement = {
    nodeName: ElementNames;
    attributes: Record<string, DOMNodeAttribute>;
    childNodes: DOMNode[];
    internal_transform?: OutputTransformer;
    internal_accessibility?: {
        role?: 'button' | 'checkbox' | 'combobox' | 'list' | 'listbox' | 'listitem' | 'menu' | 'menuitem' | 'option' | 'progressbar' | 'radio' | 'radiogroup' | 'tab' | 'tablist' | 'table' | 'textbox' | 'timer' | 'toolbar';
        state?: {
            busy?: boolean;
            checked?: boolean;
            disabled?: boolean;
            expanded?: boolean;
            multiline?: boolean;
            multiselectable?: boolean;
            readonly?: boolean;
            required?: boolean;
            selected?: boolean;
        };
    };
    isHidden?: boolean;
    isStaticDirty?: boolean;
    staticNode?: DOMElement;
    previousStaticNode?: DOMElement;
    onComputeLayout?: () => void;
    onRender?: () => void;
    onImmediateRender?: () => void;
    onStaticChange?: () => void;
    internal_layoutListeners?: Set<LayoutListener>;
} & InkNode;
export type TextNode = {
    nodeName: TextName;
    nodeValue: string;
} & InkNode;
export type DOMNode<T = {
    nodeName: NodeNames;
}> = T extends {
    nodeName: infer U;
} ? U extends '#text' ? TextNode : DOMElement : never;
export type DOMNodeAttribute = boolean | string | number;
export declare const createNode: (nodeName: ElementNames) => DOMElement;
export declare const appendChildNode: (node: DOMElement, childNode: DOMElement) => void;
export declare const insertBeforeNode: (node: DOMElement, newChildNode: DOMNode, beforeChildNode: DOMNode) => void;
export declare const removeChildNode: (node: DOMElement, removedNode: DOMNode) => void;
/**
Free the Yoga (WASM) memory of a removed subtree, then drop the `yogaNode`
reference on every DOM node within it.

`freeRecursive()` releases the WASM memory but leaves each JS wrapper object
truthy, so every `?.yogaNode` guard in the codebase would still pass and then
trap on a use-after-free when the wrapper is dereferenced (see
QwenLM/qwen-code#6820). Nulling the references makes those guards effective and
turns any lingering access into a safe no-op.
*/
export declare const freeYogaSubtree: (removedNode: DOMNode) => void;
export declare const setAttribute: (node: DOMElement, key: string, value: DOMNodeAttribute) => void;
/**
Update a text transform and invalidate measurements that include its output.
*/
export declare const setTransform: (node: DOMElement, transform: OutputTransformer | undefined) => void;
export declare const setStyle: (node: DOMNode, style?: Styles) => void;
export declare const createTextNode: (text: string) => TextNode;
export declare const setNodeHidden: (node: DOMElement, isHidden: boolean) => void;
export declare const setTextNodeValue: (node: TextNode, text: string) => void;
export declare const addLayoutListener: (rootNode: DOMElement, listener: LayoutListener) => (() => void);
export declare const emitLayoutListeners: (rootNode: DOMElement) => void;
export {};
