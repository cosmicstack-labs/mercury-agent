import { createContext } from 'react';
/**
`AppContext` is a React context that exposes lifecycle methods for the app.
*/
// Keep the default value typed so `useApp()` preserves the public `exit(errorOrResult?)` signature.
const noopSuspension = {
    async resume() { },
    async [Symbol.asyncDispose]() { },
};
const defaultValue = {
    exit(_errorOrResult) { },
    async waitUntilRenderFlush() { },
    suspendTerminal: (async (callback) => {
        if (callback) {
            await callback();
            return undefined;
        }
        return noopSuspension;
    }),
};
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext(defaultValue);
AppContext.displayName = 'InternalAppContext';
export default AppContext;
