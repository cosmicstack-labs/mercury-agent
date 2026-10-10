type Options = {
    /**
    Enable or disable the paste handler. Useful when multiple components use `usePaste` and only one should be active at a time.

    @default true
    */
    isActive?: boolean;
};
/**
A React hook that calls `handler` whenever the user pastes text in the terminal. Bracketed paste mode (`\x1b[?2004h`) is automatically enabled while the hook is active, so pasted text arrives as a single string rather than being misinterpreted as individual key presses.

`usePaste` and `useInput` can be used together in the same component. They operate on separate event channels, so paste content is never forwarded to `useInput` handlers when `usePaste` is active.

```
import {useInput, usePaste} from 'ink';

const MyInput = () => {
    useInput((input, key) => {
        // Only receives typed characters and key events, not pasted text.
        if (key.return) {
            // Submit
        }
    });

    usePaste((text) => {
        // Receives the full pasted string, including newlines.
        console.log('Pasted:', text);
    });

    return …
};
```
*/
declare const usePaste: (handler: (text: string) => void, options?: Options) => void;
export default usePaste;
