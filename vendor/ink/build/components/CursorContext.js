import { createContext } from 'react';
// eslint-disable-next-line @typescript-eslint/naming-convention
const CursorContext = createContext({
    setCursorPosition() { },
});
CursorContext.displayName = 'InternalCursorContext';
export default CursorContext;
