import {accessSync, constants} from "node:fs";

export function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Detect the user's preferred shell, falling back zsh → bash → sh. */
export function detectShell(): string {
    const envShell = process.env.SHELL;
    if (envShell && isExecutable(envShell)) return envShell;

    const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const shell of candidates) {
        if (isExecutable(shell)) return shell;
    }
    return '/bin/sh';
}
