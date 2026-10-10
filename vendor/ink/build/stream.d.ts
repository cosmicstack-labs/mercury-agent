export type OutputStream = NodeJS.WritableStream & {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    destroyed?: boolean;
    writableEnded?: boolean;
};
type RawModeStream = NodeJS.ReadableStream & {
    isTTY: true;
    setRawMode: (isEnabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
};
export declare const isTty: (stream: NodeJS.ReadableStream) => boolean;
export declare const getRawModeStream: (stdin: NodeJS.ReadableStream) => RawModeStream | undefined;
export {};
