import terminalSize from 'terminal-size';
const resolveDimension = (value, fallback, defaultValue) => {
    if (value !== undefined && value > 0) {
        return value;
    }
    return fallback !== undefined && fallback > 0 ? fallback : defaultValue;
};
/**
Get the effective terminal dimensions from the given stdout stream.

Falls back to `terminal-size` for columns in piped processes where `stdout.columns` is 0, and uses standard defaults (80×24) when dimensions cannot be determined.
*/
export const getWindowSize = (stdout) => {
    // `stdout.columns`/`rows` can be 0 or undefined in non-TTY environments.
    const columns = stdout.columns ?? 0;
    const rows = stdout.rows ?? 0;
    if (Boolean(columns) && Boolean(rows)) {
        return { columns, rows };
    }
    const fallbackSize = terminalSize();
    return {
        columns: resolveDimension(columns, fallbackSize.columns, 80),
        rows: resolveDimension(rows, fallbackSize.rows, 24),
    };
};
