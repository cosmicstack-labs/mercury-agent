import Yoga from 'yoga-layout';
import measureText from './measure-text.js';
import wrapText from './wrap-text.js';
import squashTextNodes from './squash-text-nodes.js';
export const createNode = (nodeName) => {
    const node = {
        nodeName,
        style: {},
        attributes: {},
        childNodes: [],
        parentNode: undefined,
        yogaNode: nodeName === 'ink-virtual-text' ? undefined : Yoga.Node.create(),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        internal_accessibility: {},
    };
    if (nodeName === 'ink-text') {
        node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node));
    }
    return node;
};
export const appendChildNode = (node, childNode) => {
    if (childNode.parentNode) {
        removeChildNode(childNode.parentNode, childNode);
    }
    childNode.parentNode = node;
    node.childNodes.push(childNode);
    if (childNode.yogaNode) {
        node.yogaNode?.insertChild(childNode.yogaNode, node.yogaNode.getChildCount());
    }
    if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
        markNodeAsDirty(node);
    }
};
export const insertBeforeNode = (node, newChildNode, beforeChildNode) => {
    if (newChildNode.parentNode) {
        removeChildNode(newChildNode.parentNode, newChildNode);
    }
    newChildNode.parentNode = node;
    const index = node.childNodes.indexOf(beforeChildNode);
    if (index >= 0) {
        node.childNodes.splice(index, 0, newChildNode);
        if (newChildNode.yogaNode) {
            node.yogaNode?.insertChild(newChildNode.yogaNode, index);
        }
    }
    else {
        node.childNodes.push(newChildNode);
        if (newChildNode.yogaNode) {
            node.yogaNode?.insertChild(newChildNode.yogaNode, node.yogaNode.getChildCount());
        }
    }
    if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
        markNodeAsDirty(node);
    }
};
export const removeChildNode = (node, removedNode) => {
    if (removedNode.yogaNode) {
        removedNode.parentNode?.yogaNode?.removeChild(removedNode.yogaNode);
    }
    removedNode.parentNode = undefined;
    const index = node.childNodes.indexOf(removedNode);
    if (index >= 0) {
        node.childNodes.splice(index, 1);
    }
    if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
        markNodeAsDirty(node);
    }
};
const nullifyYogaNodes = (node) => {
    node.yogaNode = undefined;
    if (node.nodeName !== '#text') {
        for (const childNode of node.childNodes) {
            nullifyYogaNodes(childNode);
        }
    }
};
/**
Free the Yoga (WASM) memory of a removed subtree, then drop the `yogaNode`
reference on every DOM node within it.

`freeRecursive()` releases the WASM memory but leaves each JS wrapper object
truthy, so every `?.yogaNode` guard in the codebase would still pass and then
trap on a use-after-free when the wrapper is dereferenced (see
QwenLM/qwen-code#6820). Nulling the references makes those guards effective and
turns any lingering access into a safe no-op.
*/
export const freeYogaSubtree = (removedNode) => {
    removedNode.yogaNode?.unsetMeasureFunc();
    removedNode.yogaNode?.freeRecursive();
    nullifyYogaNodes(removedNode);
};
export const setAttribute = (node, key, value) => {
    if (key === 'internal_accessibility') {
        node.internal_accessibility = value;
        return;
    }
    node.attributes[key] = value;
};
/**
Update a text transform and invalidate measurements that include its output.
*/
export const setTransform = (node, transform) => {
    node.internal_transform = transform;
    // Nested transforms contribute to the enclosing text node's measured content.
    if (node.nodeName === 'ink-virtual-text') {
        markNodeAsDirty(node);
    }
};
export const setStyle = (node, style) => {
    if (node.nodeName === 'ink-text' && node.style.textWrap !== style?.textWrap) {
        // Wrapping changes text measurements without changing any Yoga style.
        node.yogaNode?.markDirty();
    }
    // Rendering code assumes style is always an object.
    node.style = style ?? {};
};
export const createTextNode = (text) => {
    const node = {
        nodeName: '#text',
        nodeValue: text,
        yogaNode: undefined,
        parentNode: undefined,
        style: {},
    };
    setTextNodeValue(node, text);
    return node;
};
const measureTextNode = function (node, width, widthMode) {
    const text = node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node);
    const dimensions = measureText(text);
    // An unconstrained Yoga measurement requests the natural size, not wrapping or truncation at its NaN width.
    // Text fits into container, no need to wrap
    if (widthMode === Yoga.MEASURE_MODE_UNDEFINED || dimensions.width <= width) {
        return dimensions;
    }
    const textWrap = node.style?.textWrap ?? 'wrap';
    const wrappedText = wrapText(text, width, textWrap);
    const wrappedDimensions = measureText(wrappedText);
    // Reserve the truncation width so rendering does not truncate again at a narrower width when a wide character leaves an unused column.
    return textWrap.startsWith('truncate')
        ? { width, height: wrappedDimensions.height }
        : wrappedDimensions;
};
const findClosestYogaNode = (node) => node?.parentNode
    ? (node.yogaNode ?? findClosestYogaNode(node.parentNode))
    : undefined;
const markNodeAsDirty = (node) => {
    // Mark closest Yoga node as dirty to measure text dimensions again
    const yogaNode = findClosestYogaNode(node);
    yogaNode?.markDirty();
};
export const setNodeHidden = (node, isHidden) => {
    node.isHidden = isHidden;
    node.yogaNode?.setDisplay(isHidden || node.style.display === 'none'
        ? Yoga.DISPLAY_NONE
        : Yoga.DISPLAY_FLEX);
    if (node.nodeName === 'ink-virtual-text') {
        markNodeAsDirty(node);
    }
};
export const setTextNodeValue = (node, text) => {
    if (typeof text !== 'string') {
        // eslint-disable-next-line unicorn/no-useless-coercion -- Runtime guard for callers that pass non-string values despite the type.
        text = String(text);
    }
    node.nodeValue = text;
    markNodeAsDirty(node);
};
export const addLayoutListener = (rootNode, listener) => {
    if (rootNode.nodeName !== 'ink-root') {
        return () => { };
    }
    rootNode.internal_layoutListeners ??= new Set();
    rootNode.internal_layoutListeners.add(listener);
    return () => {
        rootNode.internal_layoutListeners?.delete(listener);
    };
};
export const emitLayoutListeners = (rootNode) => {
    if (rootNode.nodeName !== 'ink-root' || !rootNode.internal_layoutListeners) {
        return;
    }
    for (const listener of rootNode.internal_layoutListeners) {
        listener();
    }
};
