/* ═══════════════════════════════════════════════════════════════
   Event streams that work in both homes of this UI.

   Same-origin (served by the runtime): the browser's EventSource, which
   sends the session cookie and reconnects by itself.

   Hosted by a shell (Mercury Desktop, phones): EventSource cannot send an
   Authorization header, so the stream is a fetch() with the Bearer token,
   parsed frame by frame, with the same reconnect behaviour. Call sites
   see one interface either way.
   ═══════════════════════════════════════════════════════════════ */

import { apiUrl, authHeaders, handleUnauthorized, isRemoteMode } from "./connection";

type Listener = (event: MessageEvent) => void;

export interface EventStream {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  readonly readyState: number;
}

export function createEventStream(path: string): EventStream {
  if (!isRemoteMode()) {
    return new EventSource(apiUrl(path)) as unknown as EventStream;
  }
  return new BearerEventStream(apiUrl(path));
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

class BearerEventStream implements EventStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = CONNECTING;

  private readonly listeners = new Map<string, Set<Listener>>();
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastEventId = "";

  constructor(private readonly url: string) {
    void this.connect();
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = CLOSED;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private emit(type: string, data: string, id: string): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    const event = new MessageEvent(type, { data, lastEventId: id });
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        /* a listener's bug must not kill the stream */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CONNECTING;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt) + Math.random() * 250;
    this.attempt = Math.min(this.attempt + 1, 6);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.readyState === CLOSED) return;
    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...authHeaders(),
          ...(this.lastEventId ? { "Last-Event-ID": this.lastEventId } : {}),
        },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return;
      this.onerror?.();
      this.scheduleReconnect();
      return;
    }
    if (response.status === 401) {
      this.onerror?.();
      this.close();
      handleUnauthorized();
      return;
    }
    if (!response.ok || !response.body) {
      this.onerror?.();
      this.scheduleReconnect();
      return;
    }

    this.readyState = OPEN;
    this.attempt = 0;
    this.onopen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.id) this.lastEventId = frame.id;
          this.emit(frame.event, frame.data, frame.id);
        }
      }
    } catch {
      /* network drop: fall through to reconnect */
    }
    if (controller.signal.aborted || this.readyState === CLOSED) return;
    this.onerror?.();
    this.scheduleReconnect();
  }
}

export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

/** Incremental text/event-stream parser (same rules as the CLI's attach client). */
export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let id = "";

  const flush = (frames: SseFrame[]): void => {
    if (eventName || dataLines.length > 0) {
      frames.push({ event: eventName || "message", data: dataLines.join("\n"), id });
    }
    eventName = "";
    dataLines = [];
  };

  return {
    push(chunk: string): SseFrame[] {
      const frames: SseFrame[] = [];
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) {
          flush(frames);
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keepalive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") eventName = value;
        else if (field === "data") dataLines.push(value);
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      return frames;
    },
  };
}
