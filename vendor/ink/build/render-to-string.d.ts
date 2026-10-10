import { type ReactNode } from 'react';
export type RenderToStringOptions = {
    /**
    Width of the virtual terminal in columns.

    @default 80
    */
    columns?: number;
};
/**
Render a React element to a string synchronously. Unlike `render()`, this function does not write to stdout, does not set up any terminal event listeners, and returns the rendered output as a string.

Useful for generating documentation, writing output to files, testing, or any scenario where you need the rendered output as a string without starting a persistent terminal application.

**Notes:**

- Terminal-specific hooks (`useInput`, `useStdin`, `useStdout`, `useStderr`, `useApp`, `useFocus`, `useFocusManager`) return default no-op values since there is no terminal session. They will not throw, but they will not function as in a live terminal.
- `useEffect` callbacks will execute during rendering (due to synchronous rendering mode), but state updates they trigger will not affect the returned output, which reflects the initial render.
- `useLayoutEffect` callbacks fire synchronously during commit, so state updates they trigger **will** be reflected in the output.
- The `<Static>` component is supported — its output is prepended to the dynamic output.
- If a component throws during rendering, the error is propagated to the caller after cleanup.

@example
```
import {renderToString, Text, Box} from 'ink';

const output = renderToString(
    <Box padding={1}>
        <Text color="green">Hello World</Text>
    </Box>,
    {columns: 40}
);

console.log(output);
```
*/
declare const renderToString: (node: ReactNode, options?: RenderToStringOptions) => string;
export default renderToString;
