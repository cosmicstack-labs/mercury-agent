import { type ReactNode } from 'react';
import { type CursorPosition } from './log-update.js';
import { type TerminalSuspension } from './components/AppContext.js';
import { type KittyKeyboardOptions } from './kitty-keyboard.js';
import { type OutputStream } from './stream.js';
export declare const homeAndEraseDown: string;
/**
Performance metrics for a render operation.
*/
export type RenderMetrics = {
    /**
    Time spent rendering in milliseconds.
    */
    renderTime: number;
};
export type Options = {
    stdout: OutputStream;
    stdin: NodeJS.ReadableStream;
    stderr: OutputStream;
    debug: boolean;
    exitOnCtrlC: boolean;
    patchConsole: boolean;
    onRender?: (metrics: RenderMetrics) => void;
    isScreenReaderEnabled?: boolean;
    waitUntilExit?: () => Promise<unknown>;
    maxFps?: number;
    incrementalRendering?: boolean;
    /**
    Enable React Concurrent Rendering mode.

    When enabled:
    - Suspense boundaries work correctly with async data
    - `useTransition` and `useDeferredValue` are fully functional
    - Updates can be interrupted for higher priority work

    Note: Concurrent mode changes the timing of renders. Some tests may need to use `act()` to properly await updates. Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change the rendering mode or create a fresh instance.

    @default false
    @experimental
    */
    concurrent?: boolean;
    kittyKeyboard?: KittyKeyboardOptions;
    /**
    Override automatic interactive mode detection.

    By default, Ink detects whether the environment is interactive based on CI detection (via [`is-in-ci`](https://github.com/sindresorhus/is-in-ci)) and `stdout.isTTY`. Most users should not need to set this.

    When non-interactive, Ink disables ANSI erase sequences, cursor manipulation, synchronized output, resize handling, and kitty keyboard auto-detection, writing only the final frame at unmount.

    Set to `false` to force non-interactive mode or `true` to force interactive mode when the automatic detection doesn't suit your use case.

    Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

    @default true (false if in CI or `stdout.isTTY` is falsy)

    @see {@link RenderOptions.interactive}
    */
    interactive?: boolean;
    /**
    Render the app in the terminal's alternate screen buffer. When enabled, the app renders on a separate screen, and the original terminal content is restored when the app exits. This is the same mechanism used by programs like vim, htop, and less.

    Note: The terminal's scrollback buffer is not available while in the alternate screen. This is standard terminal behavior; programs like vim use the alternate screen specifically to avoid polluting the user's scrollback history.

    Note: Ink intentionally treats alternate-screen teardown output as disposable. It does not preserve or replay teardown-time frames, hook writes, or `console.*` output after restoring the primary screen.

    Only works in interactive mode. Ignored when `interactive` is `false` or in a non-interactive environment (CI, piped stdout).

    Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

    @default false

    @see {@link RenderOptions.alternateScreen}
    */
    alternateScreen?: boolean;
};
export default class Ink {
    private readonly options;
    private readonly log;
    private cursorPosition;
    private readonly throttledLog;
    private readonly isScreenReaderEnabled;
    private readonly interactive;
    private readonly renderThrottleMs;
    private alternateScreen;
    private isUnmounted;
    private isUnmounting;
    private lastOutput;
    private lastOutputToRender;
    private lastOutputHeight;
    private lastTerminalWidth;
    private lastTerminalHeight;
    private readonly container;
    private readonly rootNode;
    private fullStaticOutput;
    private hasRenderedStaticOutput;
    private readonly exitPromise;
    private exitResult;
    private beforeExitHandler?;
    private restoreConsole?;
    private readonly unsubscribeResize?;
    private readonly throttledOnRender?;
    private hasPendingThrottledRender;
    private kittyProtocolEnabled;
    private kittyFlags;
    private finishKittyDetection?;
    private nextRenderCommit?;
    private isSuspended;
    private pauseInput?;
    private resumeInput?;
    /**
    Whether this instance is using concurrent rendering mode.
    */
    readonly isConcurrent: boolean;
    resized: () => void;
    resolveExitPromise: (result?: unknown) => void;
    rejectExitPromise: (reason?: Error) => void;
    unsubscribeExit: () => void;
    handleAppExit: (errorOrResult?: unknown) => void;
    setCursorPosition: (position: CursorPosition | undefined) => void;
    handleKittyQueryResponse: () => void;
    restoreLastOutput: () => void;
    calculateLayout: () => void;
    handleStaticChange: () => void;
    onRender: () => void;
    constructor(options: Options);
    private renderFrame;
    private setAlternateScreen;
    private resolveInteractiveOption;
    private resolveAlternateScreenOption;
    private shouldSync;
    private writeBestEffort;
    private awaitExit;
    private hasPendingConcurrentWork;
    private awaitNextRender;
    private renderInteractiveFrame;
    private initKittyKeyboard;
    private confirmKittySupport;
    private enableKittyProtocol;
    private beginSuspend;
    private endSuspend;
    render(node: ReactNode): void;
    writeToStdout(data: string): void;
    writeToStderr(data: string): void;
    unmount(error?: Error | number | null): void;
    waitUntilExit(): Promise<unknown>;
    waitUntilRenderFlush(): Promise<void>;
    clear(): void;
    patchConsole(): void;
    registerInputControl(pauseInput: () => void, resumeInput: () => void): void;
    suspendTerminal(callback: () => void | Promise<void>): Promise<void>;
    suspendTerminal(): Promise<TerminalSuspension>;
}
