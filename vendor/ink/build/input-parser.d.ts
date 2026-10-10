export type InputEvent = string | {
    readonly paste: string;
};
/**
Whether `input` is exactly one complete CSI or SS3 sequence as the parser defines it, including legacy `ESC[[A`, rxvt `ESC[2$` and parameterized SS3 forms. Partial sequences (timeout-flushed) and plain escaped code points are not.
*/
export declare const isCompleteControlSequence: (input: string) => boolean;
export type InputParser = {
    push: (chunk: string) => InputEvent[];
    hasPendingEscape: () => boolean;
    flushPendingEscape: () => string | undefined;
    reset: () => void;
};
export declare const createInputParser: () => InputParser;
