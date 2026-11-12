import readline from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { closeAsk } from '../cli/ask.js';
import chalk from 'chalk';

/**
 * How many terminal rows these lines take: a line wider than the terminal
 * wraps onto more rows. Counting one row per line under-moved the cursor
 * on a redraw and overwrote part of a long title — a device token from
 * /server showed cut off.
 */
export function screenRows(lines: string[], columns: number): number {
  const cols = Math.max(1, columns);
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(stringWidth(stripVTControlCharacters(line)) / cols)), 0);
}

export interface ArrowSelectOption {
  value: string;
  label: string;
}

export interface ArrowSelectConfig {
  helperText?: string;
  maxVisibleOptions?: number;
  signal?: AbortSignal;
}

export class ArrowSelectCancelledError extends Error {
  constructor(message: string = 'Arrow select cancelled') {
    super(message);
    this.name = 'ArrowSelectCancelledError';
  }
}

export async function selectWithArrowKeys(
  title: string,
  options: ArrowSelectOption[],
  config: ArrowSelectConfig = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || options.length === 0) {
    return options[0]?.value ?? '';
  }

  // The shared question readline (ask.ts) releases itself on a deferred
  // setImmediate, and readline.close() pauses stdin. Taking over stdin here
  // and letting that release land afterwards left nothing reading the
  // terminal: the event loop drained and the wizard exited 0 at the menu.
  // Release it now, synchronously, before we own stdin.
  closeAsk();
  readline.emitKeypressEvents(process.stdin);

  const stdin = process.stdin;
  const stdout = process.stdout;
  const canUseRawMode = typeof stdin.setRawMode === 'function';
  const helperText = config.helperText || 'Use the arrow keys, then press Enter.';
  const maxVisibleOptions = Math.max(
    1,
    Math.min(
      options.length,
      config.maxVisibleOptions ?? Math.max(5, (stdout.rows || 12) - 7),
    ),
  );
  let activeIndex = 0;
  /** Rows the last render took on screen (wrapped lines count for each row they fill). */
  let renderedRows = 0;
  let windowStart = 0;

  const topIndicator = (hasHiddenAbove: boolean) => (
    hasHiddenAbove ? chalk.dim('  ↑ more') : '  '
  );
  const bottomIndicator = (hasHiddenBelow: boolean) => (
    hasHiddenBelow ? chalk.dim('  ↓ more') : '  '
  );

  const writeLines = (lines: string[]) => {
    // Back to the top of what was drawn, clear it all, draw again: a redraw
    // never leaves pieces of a longer frame, nor eats into a wrapped title.
    if (renderedRows > 0) {
      readline.moveCursor(stdout, 0, -(renderedRows - 1));
    }
    readline.cursorTo(stdout, 0);
    readline.clearScreenDown(stdout);
    stdout.write(lines.join('\n'));
    renderedRows = screenRows(lines, stdout.columns || 80);
  };

  const render = () => {
    if (activeIndex < windowStart) {
      windowStart = activeIndex;
    } else if (activeIndex >= windowStart + maxVisibleOptions) {
      windowStart = activeIndex - maxVisibleOptions + 1;
    }

    const visibleOptions = options.slice(windowStart, windowStart + maxVisibleOptions);
    const hasHiddenAbove = windowStart > 0;
    const hasHiddenBelow = windowStart + maxVisibleOptions < options.length;
    const lines = [
      // A title can span lines (a token to copy, an explanation): each is its own row, never cut.
      ...title.split('\n').map((line) => (line ? chalk.bold.white(`  ${line}`) : '')),
      chalk.dim(`  ${helperText}`),
      '',
      topIndicator(hasHiddenAbove),
      ...visibleOptions.map((option, visibleIndex) => {
        const index = windowStart + visibleIndex;
        const isActive = index === activeIndex;
        const marker = isActive ? chalk.cyanBright('●') : chalk.dim('·');
        const text = isActive ? chalk.cyanBright(option.label) : chalk.dim(option.label);
        return `  ${marker} ${text}`;
      }),
      bottomIndicator(hasHiddenBelow),
      '',
    ];

    writeLines(lines);
  };

  return await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      config.signal?.removeEventListener('abort', onAbort);
      if (canUseRawMode) {
        stdin.setRawMode(false);
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new ArrowSelectCancelledError());
    };

    const onKeypress = (_input: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.kill(process.pid, 'SIGINT');
        return;
      }

      if (key.name === 'up') {
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key.name === 'down') {
        activeIndex = (activeIndex + 1) % options.length;
        render();
        return;
      }

      if (key.name === 'return') {
        const selected = options[activeIndex]?.value ?? '';
        cleanup();
        stdout.write('\n');
        resolve(selected);
      }
    };

    if (canUseRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('keypress', onKeypress);
    config.signal?.addEventListener('abort', onAbort, { once: true });

    if (config.signal?.aborted) {
      onAbort();
      return;
    }

    render();
  });
}
