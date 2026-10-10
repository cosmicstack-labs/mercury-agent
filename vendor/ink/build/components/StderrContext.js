import process from 'node:process';
import { createContext } from 'react';
/**
`StderrContext` is a React context that exposes the stderr stream.
*/
// eslint-disable-next-line @typescript-eslint/naming-convention
const StderrContext = createContext({
    stderr: process.stderr,
    write() { },
});
StderrContext.displayName = 'InternalStderrContext';
export default StderrContext;
