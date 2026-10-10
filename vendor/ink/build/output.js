import stringWidth from 'string-width';
import { styledCharsFromTokens, styledCharsToString, tokenize, } from '@alcalzone/ansi-tokenize';
// Replaces a partially visible wide character with a space that keeps its styles.
const blankCell = (cell) => ({
    ...cell,
    value: ' ',
    fullWidth: false,
});
// An undefined bound means "unbounded on this edge", so intersecting keeps whichever bound is defined and takes the tighter one when both are.
const intersectBound = (a, b, tighter) => {
    if (a === undefined) {
        return b;
    }
    return b === undefined ? a : tighter(a, b);
};
// Bounds are half-open: `x2`/`y2` are exclusive, so an axis is empty as soon as its lower bound reaches its upper one.
const isClipEmpty = (clip) => (clip.x1 !== undefined && clip.x2 !== undefined && clip.x1 >= clip.x2) ||
    (clip.y1 !== undefined && clip.y2 !== undefined && clip.y1 >= clip.y2);
const intersectClips = (outer, inner) => {
    if (!outer) {
        return inner;
    }
    return {
        x1: intersectBound(outer.x1, inner.x1, Math.max),
        x2: intersectBound(outer.x2, inner.x2, Math.min),
        y1: intersectBound(outer.y1, inner.y1, Math.max),
        y2: intersectBound(outer.y2, inner.y2, Math.min),
    };
};
class OutputCaches {
    widths = new Map();
    blockWidths = new Map();
    styledChars = new Map();
    getStyledChars(line) {
        let cached = this.styledChars.get(line);
        if (cached === undefined) {
            // Standalone invisible Unicode characters must not occupy terminal cells.
            cached = styledCharsFromTokens(tokenize(line)).filter(character => !/^\p{Default_Ignorable_Code_Point}+$/u.test(character.value));
            this.styledChars.set(line, cached);
        }
        return cached;
    }
    getStringWidth(text) {
        let cached = this.widths.get(text);
        if (cached === undefined) {
            cached = stringWidth(text);
            this.widths.set(text, cached);
        }
        return cached;
    }
    getWidestLine(text) {
        let cached = this.blockWidths.get(text);
        if (cached === undefined) {
            let lineWidth = 0;
            for (const line of text.split('\n')) {
                lineWidth = Math.max(lineWidth, this.getStringWidth(line));
            }
            cached = lineWidth;
            this.blockWidths.set(text, cached);
        }
        return cached;
    }
}
export default class Output {
    operations = [];
    caches = new OutputCaches();
    width;
    height;
    constructor(options) {
        const { width, height } = options;
        this.width = width;
        this.height = height;
    }
    applyWriteOperation(output, operation, clip) {
        const { text, transformers } = operation;
        let { x, y } = operation;
        // Preserve styles across explicit newlines before clipping individual rows.
        const characterLines = [[]];
        for (const character of this.caches.getStyledChars(text)) {
            if (character.value === '\n') {
                characterLines.push([]);
            }
            else {
                characterLines.at(-1).push(character);
            }
        }
        let lines = characterLines.map(line => styledCharsToString(line));
        if (clip) {
            // Two nested clips can intersect to nothing. Nothing is visible, so bail out before slicing.
            if (isClipEmpty(clip)) {
                return;
            }
            const shouldClipHorizontally = typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number';
            const shouldClipVertically = typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number';
            // If text is positioned outside of clipping area altogether,
            // skip to the next operation to avoid unnecessary calculations
            if (shouldClipHorizontally) {
                const width = this.caches.getWidestLine(text);
                if (x + width < clip.x1 || x > clip.x2) {
                    return;
                }
            }
            if (shouldClipVertically) {
                const height = lines.length;
                if (y + height < clip.y1 || y > clip.y2) {
                    return;
                }
            }
            if (shouldClipHorizontally) {
                lines = lines.map(line => {
                    const from = x < clip.x1 ? clip.x1 - x : 0;
                    const width = this.caches.getStringWidth(line);
                    const to = x + width > clip.x2 ? clip.x2 - x : width;
                    return this.sliceLineToColumns(line, from, to);
                });
                if (x < clip.x1) {
                    x = clip.x1;
                }
            }
            if (shouldClipVertically) {
                const from = y < clip.y1 ? clip.y1 - y : 0;
                const height = lines.length;
                const to = y + height > clip.y2 ? clip.y2 - y : height;
                lines = lines.slice(from, to);
                if (y < clip.y1) {
                    y = clip.y1;
                }
            }
        }
        for (let [index, line] of lines.entries()) {
            const currentLine = output[y + index];
            // Lines above or below the output area have no corresponding pre-initialized row.
            if (!currentLine) {
                continue;
            }
            for (const transformer of transformers) {
                line = transformer(line, index + y - operation.y);
            }
            const characters = this.caches.getStyledChars(line);
            // Nothing to write (e.g. line was clipped away).
            if (characters.length === 0) {
                continue;
            }
            let offsetX = x;
            // Wide characters (e.g. CJK) occupy two cells: a leading
            // cell with the character and a trailing placeholder with
            // value ''. When an overlapping write lands in the middle
            // of a wide character, the boundary cells need cleanup so
            // the terminal never renders a half-visible wide character.
            // Preserve the styles of cells outside the overlapping write.
            if (currentLine[offsetX]?.value === '' &&
                offsetX > 0 &&
                this.caches.getStringWidth(currentLine[offsetX - 1]?.value ?? '') > 1) {
                currentLine[offsetX - 1] = blankCell(currentLine[offsetX - 1]);
            }
            for (const character of characters) {
                currentLine[offsetX] = character;
                // Determine printed width using string-width to align with measurement
                const characterWidth = Math.max(1, this.caches.getStringWidth(character.value));
                // For multi-column characters, clear following cells to avoid stray spaces/artifacts
                if (characterWidth > 1) {
                    for (let offset = 1; offset < characterWidth; offset++) {
                        currentLine[offsetX + offset] = {
                            type: 'char',
                            // Preserve visible cells when the leading cell is outside the output.
                            value: offsetX < 0 ? ' ' : '',
                            fullWidth: false,
                            styles: character.styles,
                        };
                    }
                }
                offsetX += characterWidth;
            }
            if (currentLine[offsetX]?.value === '') {
                currentLine[offsetX] = blankCell(currentLine[offsetX]);
            }
        }
    }
    write(x, y, text, options) {
        const { transformers } = options;
        if (text === '') {
            return;
        }
        this.operations.push({
            type: 'write',
            x,
            y,
            text,
            transformers,
        });
    }
    clip(clip) {
        this.operations.push({
            type: 'clip',
            clip,
        });
    }
    unclip() {
        this.operations.push({
            type: 'unclip',
        });
    }
    // Clipping works in terminal columns. A wide character (e.g. CJK) occupies two cells, so when a clip edge falls between its halves, the character must be replaced by a space that keeps its styles, otherwise its background disappears and the rest of the line shifts by a column.
    sliceLineToColumns(line, from, to) {
        if (from >= to) {
            return '';
        }
        const result = [];
        let column = 0;
        for (const character of this.caches.getStyledChars(line)) {
            const width = this.caches.getStringWidth(character.value);
            const start = column;
            column += width;
            if (column <= from) {
                continue;
            }
            if (start >= to) {
                break;
            }
            if (width > 1 && (start < from || column > to)) {
                // Only part of this wide character is visible, so keep the cell count and styles, but drop the glyph itself.
                result.push(blankCell(character));
            }
            else {
                result.push(character);
            }
        }
        return styledCharsToString(result);
    }
    get() {
        // Initialize output array with a specific set of rows, so that margin/padding at the bottom is preserved
        const output = [];
        for (let y = 0; y < this.height; y++) {
            const row = [];
            for (let x = 0; x < this.width; x++) {
                row.push({
                    type: 'char',
                    value: ' ',
                    fullWidth: false,
                    styles: [],
                });
            }
            output.push(row);
        }
        const clips = [];
        for (const operation of this.operations) {
            if (operation.type === 'clip') {
                // Nested clips must intersect, not replace, otherwise an inner `overflow="hidden"` box lets content escape the outer clip and overwrite surrounding UI.
                clips.push(intersectClips(clips.at(-1), operation.clip));
            }
            else if (operation.type === 'unclip') {
                clips.pop();
            }
            else {
                this.applyWriteOperation(output, operation, clips.at(-1));
            }
        }
        const generatedOutput = output
            .map(line => {
            // See https://github.com/vadimdemedes/ink/pull/564#issuecomment-1637022742
            const lineWithoutEmptyItems = line.filter(item => item !== undefined);
            return styledCharsToString(lineWithoutEmptyItems).trimEnd();
        })
            .join('\n');
        return {
            output: generatedOutput,
            height: output.length,
        };
    }
}
