import isInCi from 'is-in-ci';
export const bsu = '\u{1B}[?2026h';
export const esu = '\u{1B}[?2026l';
export function shouldSynchronize(stream, isInteractive) {
    return ('isTTY' in stream &&
        stream.isTTY &&
        (isInteractive ?? !isInCi));
}
