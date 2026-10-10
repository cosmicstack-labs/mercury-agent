import React, { type ReactNode } from 'react';
import { type CursorPosition } from '../log-update.js';
import { type OutputStream } from '../stream.js';
import { type SuspendTerminal } from './AppContext.js';
type Props = {
    readonly children: ReactNode;
    readonly stdin: NodeJS.ReadableStream;
    readonly stdout: OutputStream;
    readonly stderr: OutputStream;
    readonly writeToStdout: (data: string) => void;
    readonly writeToStderr: (data: string) => void;
    readonly exitOnCtrlC: boolean;
    readonly onExit: (errorOrResult?: unknown) => void;
    readonly onWaitUntilRenderFlush: () => Promise<void>;
    readonly onSuspendTerminal: SuspendTerminal;
    readonly onKittyQueryResponse: () => void;
    readonly onRegisterInputControl: (pauseInput: () => void, resumeInput: () => void) => void;
    readonly setCursorPosition: (position: CursorPosition | undefined) => void;
    readonly interactive: boolean;
    readonly renderThrottleMs: number;
};
declare function App({ children, stdin, stdout, stderr, writeToStdout, writeToStderr, exitOnCtrlC, onExit, onWaitUntilRenderFlush, onSuspendTerminal, onKittyQueryResponse, onRegisterInputControl, setCursorPosition, interactive, renderThrottleMs, }: Props): React.ReactNode;
declare namespace App {
    var displayName: string;
}
export default App;
