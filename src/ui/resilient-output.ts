import { EventEmitter } from 'node:events';

type TtyWriteStream = NodeJS.WriteStream;

/** DECRST 2004 — mirrors `bracketedPasteSequences(false)` in channels/cli.ts. */
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

/** Backlog beyond which the terminal is considered stalled and writes are shed. */
export const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;

/**
 * Keeps Ink alive when its primary terminal stream is closed unexpectedly.
 * stderr normally points at the same TTY through a separate descriptor, so it
 * is a useful last-resort output path for an otherwise healthy agent process.
 */
export class ResilientTuiOutput extends EventEmitter {
  private active: TtyWriteStream;
  private failedOver = false;
  private outOfSync = false;
  /**
   * How to repaint after shed writes. The TUI sets this to clear the frame
   * (so the next one is written whole) and re-render. Without it, a
   * same-size 'resize' is emitted, which only re-renders.
   */
  onResync: (() => void) | null = null;
  private readonly onPrimaryError = () => this.failOver();
  private readonly onFallbackError = () => {
    // There is nowhere else to render, but an output failure must not kill an
    // active coding task. The work ledger will retain its eventual result.
  };
  private readonly onResize = () => this.emit('resize');

  constructor(
    private readonly primary: TtyWriteStream,
    private readonly fallback: TtyWriteStream,
  ) {
    super();
    this.active = primary;
    primary.on('error', this.onPrimaryError);
    fallback.on('error', this.onFallbackError);
    primary.on('resize', this.onResize);
  }

  get columns(): number {
    return this.active.columns || this.primary.columns || this.fallback.columns || 80;
  }

  get rows(): number {
    return this.active.rows || this.primary.rows || this.fallback.rows || 24;
  }

  get isTTY(): boolean {
    return Boolean(this.active.isTTY || this.primary.isTTY || this.fallback.isTTY);
  }

  hasFailedOver(): boolean {
    return this.failedOver;
  }

  dispose(): void {
    this.primary.off('error', this.onPrimaryError);
    this.fallback.off('error', this.onFallbackError);
    this.primary.off('resize', this.onResize);
    // Bracketed paste is enabled for the TUI's lifetime; a shell left in
    // that mode shows `ESC[200~` around every paste. Always reset it here —
    // this runs on every teardown path, crash handlers included.
    try { this.active.write(BRACKETED_PASTE_OFF); } catch { /* stream gone */ }
  }

  /**
   * Writes are never dropped in normal operation. The vendored renderer
   * writes DELTAS — only the rows that changed, plus hardware-cursor moves —
   * and its bookkeeping assumes every write landed. Dropping one while the
   * terminal buffer was briefly full (common on macOS during the first
   * reply's burst) left the screen and the renderer out of sync: a stale
   * "Processing" block stayed in the transcript and the reply could vanish.
   * Node buffers writes while the terminal catches up.
   *
   * Only a truly stalled terminal (backlog beyond MAX_BACKLOG_BYTES) drops
   * writes, to protect the heap; the screen is then marked out of sync and a
   * full repaint is requested as soon as the terminal drains.
   */
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const destination = this.active;
    if ((destination.writableLength ?? 0) > MAX_BACKLOG_BYTES) {
      this.markOutOfSync(destination);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return false;
    }
    try {
      if (typeof encodingOrCallback === 'function') {
        return destination.write(chunk, encodingOrCallback);
      }
      if (encodingOrCallback) {
        return destination.write(chunk, encodingOrCallback, callback);
      }
      return destination.write(chunk, callback);
    } catch {
      if (destination === this.primary) {
        this.failOver();
        try {
          return typeof encodingOrCallback === 'string'
            ? this.fallback.write(chunk, encodingOrCallback, callback)
            : this.fallback.write(chunk, typeof encodingOrCallback === 'function' ? encodingOrCallback : callback);
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /** After writes were dropped, repaint everything once the terminal drains. */
  private markOutOfSync(destination: TtyWriteStream): void {
    if (this.outOfSync) return;
    this.outOfSync = true;
    destination.once('drain', () => {
      this.outOfSync = false;
      if (this.onResync) this.onResync();
      else this.emit('resize');
    });
  }

  private failOver(): void {
    if (this.failedOver) return;
    this.failedOver = true;
    this.active = this.fallback;
    try {
      this.fallback.write('\n[Mercury recovered from a terminal output error. The active task is still running.]\n');
    } catch {
      // The task can still complete and persist even if both outputs are gone.
    }
  }

}
