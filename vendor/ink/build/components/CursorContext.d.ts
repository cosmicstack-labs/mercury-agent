import { type CursorPosition } from '../log-update.js';
export type Props = {
    /**
    Set the cursor position relative to the Ink output.

    Pass `undefined` to hide the cursor.
    */
    readonly setCursorPosition: (position: CursorPosition | undefined) => void;
};
declare const CursorContext: import("react").Context<Props>;
export default CursorContext;
