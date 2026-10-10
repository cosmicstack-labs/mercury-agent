import { type OutputTransformer } from './render-node-to-output.js';
/**
"Virtual" output class

Handles the positioning and saving of the output of each node in the tree. Also responsible for applying transformations to each character of the output.

Used to generate the final output of all nodes before writing it to actual output stream (e.g. stdout)
*/
type Options = {
    width: number;
    height: number;
};
type Clip = {
    x1: number | undefined;
    x2: number | undefined;
    y1: number | undefined;
    y2: number | undefined;
};
export default class Output {
    private readonly operations;
    private readonly caches;
    width: number;
    height: number;
    constructor(options: Options);
    private applyWriteOperation;
    write(x: number, y: number, text: string, options: {
        transformers: OutputTransformer[];
    }): void;
    clip(clip: Clip): void;
    unclip(): void;
    sliceLineToColumns(line: string, from: number, to: number): string;
    get(): {
        output: string;
        height: number;
    };
}
export {};
