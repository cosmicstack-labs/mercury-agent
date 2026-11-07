/* ═══════════════════════════════════════════════════════════════
   Server-Sent Events with a Bearer header. EventSource cannot send one,
   so this is a fetch() stream parsed frame by frame, with reconnect.
   ═══════════════════════════════════════════════════════════════ */

import { apiUrl, authHeaders } from "./client";

export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

export interface StreamHandlers {
  onOpen?: () => void;
  onClose?: (reason: "error" | "unauthorized" | "closed") => void;
  onEvent: (event: string, data: string) => void;
}

export interface StreamHandle {
  close(): void;
  readonly open: boolean;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export function openStream(path: string, handlers: StreamHandlers): StreamHandle {
  let closed = false;
  let open = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId = "";

  const schedule = () => {
    if (closed) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt) + Math.random() * 250;
    attempt = Math.min(attempt + 1, 6);
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    let res: Response;
    try {
      res = await fetch(apiUrl(path), {
        // No Cache-Control: it is not a CORS-safelisted header, and a runtime that
        // does not list it in Access-Control-Allow-Headers blocks the stream.
        headers: { Accept: "text/event-stream", ...authHeaders(), ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return;
      open = false;
      handlers.onClose?.("error");
      schedule();
      return;
    }
    if (res.status === 401) {
      closed = true;
      open = false;
      handlers.onClose?.("unauthorized");
      return;
    }
    if (!res.ok || !res.body) {
      open = false;
      handlers.onClose?.("error");
      schedule();
      return;
    }
    open = true;
    attempt = 0;
    handlers.onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.id) lastEventId = frame.id;
          try {
            handlers.onEvent(frame.event, frame.data);
          } catch {
            /* a handler's bug must not kill the stream */
          }
        }
      }
    } catch {
      /* network drop → reconnect */
    }
    open = false;
    if (closed || controller.signal.aborted) return;
    handlers.onClose?.("error");
    schedule();
  };

  void connect();

  return {
    close() {
      closed = true;
      open = false;
      if (timer) clearTimeout(timer);
      controller?.abort();
      handlers.onClose?.("closed");
    },
    get open() {
      return open;
    },
  };
}

export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let id = "";
  const flush = (frames: SseFrame[]) => {
    if (eventName || dataLines.length > 0) frames.push({ event: eventName || "message", data: dataLines.join("\n"), id });
    eventName = "";
    dataLines = [];
  };
  return {
    push(chunk) {
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
        if (line.startsWith(":")) continue;
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
