import type { OutputStream } from './stream.js';
/**
Get the effective terminal dimensions from the given stdout stream.

Falls back to `terminal-size` for columns in piped processes where `stdout.columns` is 0, and uses standard defaults (80×24) when dimensions cannot be determined.
*/
export declare const getWindowSize: (stdout: OutputStream) => {
    columns: number;
    rows: number;
};
