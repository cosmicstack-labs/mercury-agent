/**
Dimensions of the terminal window.
*/
export type WindowSize = {
    /**
    Number of columns (horizontal character cells).
    */
    readonly columns: number;
    /**
    Number of rows (vertical character cells).
    */
    readonly rows: number;
};
/**
A React hook that returns the current terminal window dimensions and re-renders the component whenever the terminal is resized.
*/
declare const useWindowSize: () => WindowSize;
export default useWindowSize;
