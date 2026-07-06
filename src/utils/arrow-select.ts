import readline from 'node:readline';
import chalk from 'chalk';

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
  let renderedLineCount = 0;
  let windowStart = 0;

  const topIndicator = (hasHiddenAbove: boolean) => (
    hasHiddenAbove ? chalk.dim('  ↑ more') : '  '
  );
  const bottomIndicator = (hasHiddenBelow: boolean) => (
    hasHiddenBelow ? chalk.dim('  ↓ more') : '  '
  );

  const writeLines = (lines: string[]) => {
    if (renderedLineCount > 0) {
      readline.moveCursor(stdout, 0, -(renderedLineCount - 1));
    }

    for (let index = 0; index < lines.length; index += 1) {
      readline.cursorTo(stdout, 0);
      readline.clearLine(stdout, 0);
      stdout.write(lines[index]);
      if (index < lines.length - 1) {
        stdout.write('\n');
      }
    }
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
      chalk.bold.white(`  ${title}`),
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
    renderedLineCount = lines.length;
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

export interface SearchSelectConfig {
  helperText?: string;
  maxVisibleOptions?: number;
  signal?: AbortSignal;
  searchPlaceholder?: string;
}

export async function searchWithArrowKeys(
  title: string,
  allOptions: ArrowSelectOption[],
  config: SearchSelectConfig = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || allOptions.length === 0) {
    return allOptions[0]?.value ?? '';
  }

  readline.emitKeypressEvents(process.stdin);

  const stdin = process.stdin;
  const stdout = process.stdout;
  const canUseRawMode = typeof stdin.setRawMode === 'function';
  const helperText = config.helperText || 'Type to search, use arrow keys to navigate, Enter to select.';
  const searchPlaceholder = config.searchPlaceholder || 'Search...';
  const maxVisibleOptions = Math.max(
    1,
    Math.min(
      10,
      config.maxVisibleOptions ?? Math.max(5, (stdout.rows || 12) - 9),
    ),
  );

  let searchQuery = '';
  let filteredOptions = allOptions;
  let activeIndex = 0;
  let renderedLineCount = 0;
  let windowStart = 0;

  const filterOptions = (query: string): ArrowSelectOption[] => {
    if (!query) return allOptions;
    const lower = query.toLowerCase();
    return allOptions.filter((opt) =>
      opt.label.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower),
    );
  };

  const writeLines = (lines: string[]) => {
    if (renderedLineCount > 0) {
      readline.moveCursor(stdout, 0, -(renderedLineCount - 1));
    }

    for (let index = 0; index < lines.length; index += 1) {
      readline.cursorTo(stdout, 0);
      readline.clearLine(stdout, 0);
      stdout.write(lines[index]);
      if (index < lines.length - 1) {
        stdout.write('\n');
      }
    }
  };

  const render = () => {
    filteredOptions = filterOptions(searchQuery);
    if (activeIndex >= filteredOptions.length) {
      activeIndex = Math.max(0, filteredOptions.length - 1);
    }

    if (activeIndex < windowStart) {
      windowStart = activeIndex;
    } else if (activeIndex >= windowStart + maxVisibleOptions) {
      windowStart = activeIndex - maxVisibleOptions + 1;
    }

    const visibleOptions = filteredOptions.slice(windowStart, windowStart + maxVisibleOptions);
    const hasHiddenAbove = windowStart > 0;
    const hasHiddenBelow = windowStart + maxVisibleOptions < filteredOptions.length;

    const searchDisplay = searchQuery
      ? chalk.cyanBright(searchQuery) + chalk.dim('▏')
      : chalk.dim(searchPlaceholder) + chalk.dim('▏');

    const resultCount = filteredOptions.length === allOptions.length
      ? chalk.dim(`  ${allOptions.length} models`)
      : chalk.dim(`  ${filteredOptions.length} of ${allOptions.length} models`);

    const lines = [
      chalk.bold.white(`  ${title}`),
      chalk.dim(`  ${helperText}`),
      '',
      `  ${chalk.dim('🔍')} ${searchDisplay}`,
      resultCount,
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
    renderedLineCount = lines.length;
  };

  const topIndicator = (hasHiddenAbove: boolean) => (
    hasHiddenAbove ? chalk.dim('  ↑ more') : '  '
  );
  const bottomIndicator = (hasHiddenBelow: boolean) => (
    hasHiddenBelow ? chalk.dim('  ↓ more') : '  '
  );

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

      if (key.name === 'escape') {
        if (searchQuery) {
          searchQuery = '';
          activeIndex = 0;
          windowStart = 0;
          render();
          return;
        }
        cleanup();
        resolve('');
        return;
      }

      if (key.name === 'up') {
        if (filteredOptions.length > 0) {
          activeIndex = (activeIndex - 1 + filteredOptions.length) % filteredOptions.length;
        }
        render();
        return;
      }

      if (key.name === 'down') {
        if (filteredOptions.length > 0) {
          activeIndex = (activeIndex + 1) % filteredOptions.length;
        }
        render();
        return;
      }

      if (key.name === 'backspace') {
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          activeIndex = 0;
          windowStart = 0;
          render();
        }
        return;
      }

      if (key.name === 'return') {
        if (filteredOptions.length === 0) {
          return;
        }
        const selected = filteredOptions[activeIndex]?.value ?? '';
        cleanup();
        stdout.write('\n');
        resolve(selected);
        return;
      }

      if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
        return;
      }

      if (_input && !key.ctrl && !key.meta && _input.length === 1) {
        searchQuery += _input;
        activeIndex = 0;
        windowStart = 0;
        render();
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
