import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
const create = (stream, { showCursor = false } = {}) => {
    let previousLineCount = 0;
    let previousOutput = '';
    let hasHiddenCursor = false;
    // Hardware cursor (Cosmic Stack patch): after a frame is written the
    // cursor sits on the line below the last row (column 0) — that is what
    // the erase arithmetic assumes. `park` moves it up onto the anchor cell
    // and shows it; `unpark` hides it and moves it back BEFORE anything else
    // is written, so the arithmetic never sees a parked cursor. Relative
    // moves (CUU/CUD/CHA) on purpose: the absolute row of the live region is
    // unknown without a DSR round-trip.
    let parked = null;
    const targetFor = (cursor, lineCount) => {
        if (!cursor) return null;
        const rows = lineCount - 1; // lineCount counts the trailing blank line
        if (!(cursor.row >= 0 && cursor.row < rows)) return null;
        return { up: rows - cursor.row, col: Math.max(0, Math.floor(cursor.col)) };
    };
    const unpark = () => {
        if (!parked) return '';
        const { up } = parked;
        parked = null;
        return ansiEscapes.cursorHide + ansiEscapes.cursorDown(up) + ansiEscapes.cursorLeft;
    };
    const park = (target) => {
        if (!target) return '';
        parked = target;
        return ansiEscapes.cursorUp(target.up) + ansiEscapes.cursorTo(target.col) + ansiEscapes.cursorShow;
    };
    const render = (str, cursor) => {
        if (!showCursor && !hasHiddenCursor) {
            cliCursor.hide();
            hasHiddenCursor = true;
        }
        const output = str + '\n';
        if (output === previousOutput) {
            // Hardware cursor (Cosmic Stack patch): same rows, but the anchor
            // may have moved or toggled — re-park without touching the frame.
            const target = targetFor(cursor, previousLineCount);
            const same = (!parked && !target) || (parked && target && parked.up === target.up && parked.col === target.col);
            if (!same) stream.write(unpark() + park(target));
            return;
        }
        // Diff-render (Cosmic Stack patch): erase and rewrite only the rows
        // from the first changed line onward; identical rows above stay on
        // screen untouched. Ink 5's log-update erased and rewrote the ENTIRE
        // frame on every render — a prompt-selection change or spinner tick
        // repainted the whole live region, which read as a full-UI flash.
        // The row bytes are compared verbatim (layout is deterministic), and
        // the erase count accounts for the trailing blank line exactly like
        // `previousLineCount` does, so `clear()` and cursor arithmetic stay
        // in sync with the original accounting.
        const previousRows = previousOutput === '' ? [] : previousOutput.slice(0, -1).split('\n');
        const nextRows = output.slice(0, -1).split('\n');
        const common = Math.min(previousRows.length, nextRows.length);
        let firstChange = 0;
        while (firstChange < common && previousRows[firstChange] === nextRows[firstChange]) {
            firstChange++;
        }
        const eraseCount = previousLineCount - firstChange;
        previousOutput = output;
        previousLineCount = output.split('\n').length;
        stream.write(unpark() + ansiEscapes.eraseLines(eraseCount) + nextRows.slice(firstChange).join('\n') + '\n' + park(targetFor(cursor, previousLineCount)));
    };
    // Resize baseline reset (Cosmic Stack patch): forget what is on screen
    // without touching the line count — the next render erases the old
    // frame's rows and rewrites every row instead of diffing against rows
    // the terminal has already re-wrapped.
    render.invalidate = () => {
        previousOutput = '';
    };
    render.clear = () => {
        stream.write(unpark() + ansiEscapes.eraseLines(previousLineCount));
        previousOutput = '';
        previousLineCount = 0;
    };
    render.done = () => {
        const restore = unpark();
        if (restore) stream.write(restore);
        previousOutput = '';
        previousLineCount = 0;
        if (!showCursor) {
            cliCursor.show();
            hasHiddenCursor = false;
        }
    };
    return render;
};
const logUpdate = { create };
export default logUpdate;
