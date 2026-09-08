import { EventEmitter } from 'node:events';

type TtyWriteStream = NodeJS.WriteStream;

/**
 * Keeps Ink alive when its primary terminal stream is closed unexpectedly.
 * stderr normally points at the same TTY through a separate descriptor, so it
 * is a useful last-resort output path for an otherwise healthy agent process.
 */
export class ResilientTuiOutput extends EventEmitter {
  private active: TtyWriteStream;
  private failedOver = false;
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
  }

  /**
   * Deliberately bypasses Node's Writable buffering. Ink repaints whole-screen
   * frames and does not honor backpressure; adding another Writable here would
   * queue every frame when a terminal is slow and eventually exhaust the heap.
   */
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const destination = this.active;
    // Ink ignores write() backpressure and repaints the whole screen. Dropping
    // an intermediate animation frame is safe; queueing thousands is not.
    if (destination.writableNeedDrain) {
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
