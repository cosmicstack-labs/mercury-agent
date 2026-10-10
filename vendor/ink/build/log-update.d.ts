import type { OutputStream } from './stream.js';
import { type CursorPosition } from './cursor-helpers.js';
export type { CursorPosition } from './cursor-helpers.js';
export type LogUpdate = {
    clear: () => void;
    done: () => void;
    reset: () => void;
    sync: (text: string) => void;
    setCursorPosition: (position: CursorPosition | undefined) => void;
    isCursorDirty: () => boolean;
    willRender: (text: string) => boolean;
    getCursorPosition: () => CursorPosition | undefined;
    (text: string): boolean;
};
declare const logUpdate: {
    create: (stream: OutputStream, { showCursor, incremental }?: {
        showCursor?: boolean | undefined;
        incremental?: boolean | undefined;
    }) => LogUpdate;
};
export default logUpdate;
