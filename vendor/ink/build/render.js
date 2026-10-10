import { Stream } from 'node:stream';
import process from 'node:process';
import Ink from './ink.js';
import instances from './instances.js';
/**
Mount a component and render the output.
*/
const render = (node, options) => {
    const { stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, exitOnCtrlC = true, patchConsole = true, ...renderOptions } = getOptions(options);
    const inkOptions = {
        stdout,
        stdin,
        stderr,
        debug: false,
        exitOnCtrlC,
        patchConsole,
        maxFps: 30,
        incrementalRendering: false,
        concurrent: false,
        alternateScreen: false,
        ...renderOptions,
    };
    const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions));
    instance.render(node);
    return {
        rerender: instance.render,
        unmount() {
            instance.unmount();
        },
        waitUntilExit: instance.waitUntilExit,
        waitUntilRenderFlush: instance.waitUntilRenderFlush,
        cleanup() {
            instance.unmount();
        },
        clear: instance.clear,
    };
};
export default render;
const getOptions = (stdout = {}) => {
    if (stdout instanceof Stream) {
        return {
            stdout,
            stdin: process.stdin,
        };
    }
    return stdout;
};
const getInstance = (stdout, createInstance) => {
    const instance = instances.get(stdout);
    if (instance === undefined) {
        const newInstance = createInstance();
        instances.set(stdout, newInstance);
        return newInstance;
    }
    // Ink keeps one live renderer per stdout. Reusing the same stream without
    // unmounting is unsupported, but return the existing instance so we don't
    // create two renderers that compete for the same output. Write the warning
    // directly to native stderr so an existing alternate-screen renderer cannot
    // swallow it via patchConsole.
    process.stderr.write('Warning: render() was called again for the same stdout before the previous Ink instance was unmounted. Reusing stdout across multiple render() calls is unsupported. Call unmount() first.\n');
    return instance;
};
