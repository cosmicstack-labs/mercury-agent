import { useState, useEffect } from 'react';
import { getWindowSize } from '../utils.js';
import useStdout from './use-stdout.js';
/**
A React hook that returns the current terminal window dimensions and re-renders the component whenever the terminal is resized.
*/
const useWindowSize = () => {
    const { stdout } = useStdout();
    const [size, setSize] = useState(() => getWindowSize(stdout));
    useEffect(() => {
        const onResize = () => {
            setSize(getWindowSize(stdout));
        };
        stdout.on('resize', onResize);
        onResize();
        return () => {
            stdout.off('resize', onResize);
        };
    }, [stdout]);
    return size;
};
export default useWindowSize;
