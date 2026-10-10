import widestLine from 'widest-line';
import QuickLRU from 'quick-lru';
const cache = new QuickLRU({ maxSize: 4096 });
const measureText = (text) => {
    if (text.length === 0) {
        return {
            width: 0,
            height: 0,
        };
    }
    const cachedDimensions = cache.get(text);
    if (cachedDimensions) {
        return cachedDimensions;
    }
    const width = widestLine(text);
    const height = text.split('\n').length;
    const dimensions = { width, height };
    cache.set(text, dimensions);
    return dimensions;
};
export default measureText;
