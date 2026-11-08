import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface ProtocolEvent { method: string; params: Record<string, unknown>; sessionId?: string }
/** Chromium's null-terminated JSON transport on inherited descriptors 3 and 4.
 * No debug listener, arbitrary endpoint, or public WebSocket is ever created. */
export class BrowserPipe {
  private id = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  onEvent: (event: ProtocolEvent) => void = () => {};
  onFailure: () => void = () => {};

  constructor(private child: ChildProcess) {
    const read = child.stdio[4] as Readable;
    read.setEncoding('utf8');
    read.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 8_000_000) { this.fail(); return; }
      let at: number;
      while ((at = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        try {
          const message = JSON.parse(raw);
          if (message.id) {
            const entry = this.pending.get(message.id);
            if (!entry) continue;
            clearTimeout(entry.timer);
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error(`Browser protocol rejected ${String(message.error.message).slice(0, 200)}`));
            else entry.resolve(message.result);
          } else this.onEvent(message);
        } catch { this.fail(); return; }
      }
    });
    read.on('error', () => this.fail());
    (child.stdio[3] as Writable).on('error', () => this.fail());
    child.on('error', () => this.fail());
    child.on('exit', () => this.fail());
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Browser is closed.'));
    if (this.pending.size >= 128 || (this.child.stdio[3] as Writable).writableLength > 8_000_000) {
      this.fail();
      return Promise.reject(new Error('Browser protocol budget exceeded.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser ${method} timed out.`));
        this.fail();
      }, 10_000);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      (this.child.stdio[3] as Writable).write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed unexpectedly.')); }
    this.pending.clear();
    this.onFailure();
  }
}
