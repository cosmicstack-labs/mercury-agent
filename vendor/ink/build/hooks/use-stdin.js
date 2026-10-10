import { use } from 'react';
import StdinContext from '../components/StdinContext.js';
/**
A React hook that returns the stdin stream and stdin-related utilities.
*/
const useStdin = () => use(StdinContext);
export const useStdinContext = () => use(StdinContext);
export default useStdin;
