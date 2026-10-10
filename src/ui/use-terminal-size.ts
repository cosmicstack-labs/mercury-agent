import React from 'react';
import { useStdout } from 'ink';
import { subscribe as subscribeTick } from './tick-store.js';

/**
 * Live terminal size. Listens to stdout resize and re-checks on the shared
 * 100 ms tick as a fallback — some terminal/pty setups (remote-desktop
 * sessions, multiplexers) don't deliver the resize event when the window
 * changes, and a stale size breaks any explicit-width layout. The check
 * is a property read; the component re-renders only when the size
 * actually changed (the snapshot object is reused while it is equal).
 * (Ink 8's useWindowSize() only listens for resize, hence the own hook.)
 */
export function useTerminalSize(): { rows: number; cols: number } {
  // Ink 8 types stdout as a generic stream; the TTY size fields are read
  // defensively (`|| 24/80`) for the non-TTY case anyway.
  const stdout = useStdout().stdout as NodeJS.WritableStream & { rows?: number; columns?: number };
  const cacheRef = React.useRef<{ rows: number; cols: number }>({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
  const getSnapshot = React.useCallback(() => {
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    const current = cacheRef.current;
    if (current.rows !== rows || current.cols !== cols) cacheRef.current = { rows, cols };
    return cacheRef.current;
  }, [stdout]);
  const subscribe = React.useCallback((listener: () => void) => {
    stdout.on('resize', listener);
    const unsubscribeTick = subscribeTick(listener);
    return () => {
      stdout.off('resize', listener);
      unsubscribeTick();
    };
  }, [stdout]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
