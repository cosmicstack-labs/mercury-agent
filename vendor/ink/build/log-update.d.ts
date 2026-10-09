import { type Writable } from 'node:stream';
export type LogUpdate = {
    clear: () => void;
    done: () => void;
    /** Resize baseline reset (Cosmic Stack patch). */
    invalidate: () => void;
    /** Hardware cursor (Cosmic Stack patch): `cursor` is the live-frame cell to park the terminal cursor on. */
    (str: string, cursor?: { row: number; col: number } | null): void;
};
declare const logUpdate: {
    create: (stream: Writable, { showCursor }?: {
        showCursor?: boolean | undefined;
    }) => LogUpdate;
};
export default logUpdate;
