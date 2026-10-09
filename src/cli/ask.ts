import readline from 'node:readline';

/**
 * Interactive prompt for the setup wizard and the `mercury <channel>`
 * pairing commands.
 *
 * One shared readline interface serves every consecutive question (#64).
 * The previous per-question interface had no `close` handler: when stdin
 * reached EOF (piped input, closed terminal, Ctrl+D) the pending question
 * never resolved, the event loop drained, and the process exited 0 as if
 * setup had finished. Now:
 *   - a `close` while a question is pending rejects it with
 *     `InputClosedError`, so the caller fails loudly (exit 1);
 *   - once stdin has ended, every later `ask()` rejects immediately instead
 *     of hanging on a stream that will never emit another line;
 *   - the interface is released as soon as no question is pending (after
 *     the current tick), so a command that asked one question still exits,
 *     and the Ink TUI that boots after the wizard gets a free stdin.
 */
export class InputClosedError extends Error {
  constructor(message = 'Input closed before the question was answered (stdin reached EOF). Run this command from an interactive terminal.') {
    super(message);
    this.name = 'InputClosedError';
  }
}

export interface AskIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

interface Prompter {
  ask(prompt: string): Promise<string>;
  close(): void;
}

export function createPrompter(io: AskIO): Prompter {
  let rl: readline.Interface | null = null;
  let inputEnded = false;
  let pending: { reject: (err: Error) => void } | null = null;
  let release: NodeJS.Immediate | null = null;
  let endHooked = false;

  const onInputEnd = () => { inputEnded = true; };

  function open(): readline.Interface {
    if (rl) return rl;
    if (!endHooked) {
      // readline removes its own listeners on close(); keep ours so an EOF
      // that lands between two questions is still remembered.
      io.input.once('end', onInputEnd);
      endHooked = true;
    }
    const iface = readline.createInterface({ input: io.input, output: io.output });
    iface.on('close', () => {
      if (rl !== iface) return; // our own release, already detached
      rl = null;
      if (pending) {
        // Closed by EOF / Ctrl+D while waiting: this is the silent-exit bug.
        inputEnded = true;
        const p = pending;
        pending = null;
        p.reject(new InputClosedError());
      }
    });
    rl = iface;
    return iface;
  }

  function close(): void {
    if (release) { clearImmediate(release); release = null; }
    const iface = rl;
    rl = null;
    iface?.close();
  }

  function scheduleRelease(): void {
    if (release) clearImmediate(release);
    release = setImmediate(() => {
      release = null;
      if (!pending) close();
    });
  }

  return {
    ask(prompt: string): Promise<string> {
      if (inputEnded) return Promise.reject(new InputClosedError());
      if (pending) return Promise.reject(new Error('ask(): a previous question is still waiting for an answer'));
      if (release) { clearImmediate(release); release = null; }
      const iface = open();
      return new Promise<string>((resolve, reject) => {
        pending = { reject };
        iface.question(prompt, (answer) => {
          pending = null;
          scheduleRelease();
          resolve(answer.trim());
        });
      });
    },
    close,
  };
}

let stdPrompter: Prompter | null = null;

function std(): Prompter {
  if (!stdPrompter) stdPrompter = createPrompter({ input: process.stdin, output: process.stdout });
  return stdPrompter;
}

/** Ask one question on the process terminal; see module docs for EOF rules. */
export function ask(prompt: string): Promise<string> {
  return std().ask(prompt);
}

/** Release the terminal readline (idempotent; normally automatic). */
export function closeAsk(): void {
  stdPrompter?.close();
}
