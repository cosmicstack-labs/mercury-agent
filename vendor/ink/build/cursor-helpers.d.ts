export type CursorPosition = {
    x: number;
    y: number;
};
declare const showCursorEscape = "\u001B[?25h";
declare const hideCursorEscape = "\u001B[?25l";
export { showCursorEscape, hideCursorEscape };
/**
Compare two cursor positions. Returns true if they differ.
*/
export declare const cursorPositionChanged: (a: CursorPosition | undefined, b: CursorPosition | undefined) => boolean;
/**
Build escape sequence to move cursor from the bottom of the output to the target position and show it.

`bottomLine` is the row the renderer left the cursor on, counted from the top of the output.
That is always `lines.length - 1` for `lines = str.split('\n')`, whether or not the output ends
with a newline:

- With a trailing newline, `split` yields one extra empty element and the renderer stops just
  past the last visible line — which is `lines.length - 1`.
- Without one, there is no extra element and the renderer deliberately stops on the last visible
  line instead of moving past it — which is also `lines.length - 1`.

This is the same row basis `buildReturnToBottom` measures from, so the two stay in step.
*/
export declare const buildCursorSuffix: (bottomLine: number, cursorPosition: CursorPosition | undefined) => string;
/**
Build escape sequence to move cursor from previousCursorPosition back to the bottom of output.
This must be done before eraseLines or any operation that assumes cursor is at the bottom.
*/
export declare const buildReturnToBottom: (previousLineCount: number, previousCursorPosition: CursorPosition | undefined) => string;
export type CursorOnlyInput = {
    cursorWasShown: boolean;
    previousLineCount: number;
    previousCursorPosition: CursorPosition | undefined;
    cursorPosition: CursorPosition | undefined;
};
/**
Build the escape sequence for cursor-only updates (output unchanged, cursor moved).
Hides cursor if it was previously shown, returns to bottom, then repositions.

`buildReturnToBottom` has just placed the cursor on row `previousLineCount - 1`, so the
suffix measures from there rather than recomputing the row from the output.
*/
export declare const buildCursorOnlySequence: (input: CursorOnlyInput) => string;
/**
Build the prefix that hides cursor and returns to bottom before erasing or rewriting.
Returns empty string if cursor was not shown.
*/
export declare const buildReturnToBottomPrefix: (wasCursorShown: boolean, previousLineCount: number, previousCursorPosition: CursorPosition | undefined) => string;
/**
Build the sequence that erases the previous frame, as `clear` does before other output is written.

With a cursor shown, the frame's top row is found relative to the cursor instead of returning to the bottom first. A terminal shrinking its rows drops the rows below the cursor before scrolling anything, so the frame's bottom rows may be gone: moving down clamps at the last row and erasing upward from there reaches into the content above the frame.
*/
export declare const buildEraseFrame: (previousLineCount: number, previousCursorPosition: CursorPosition | undefined) => string;
