import { useEffect, useRef, useCallback, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { createEventStream, type EventStream } from "@/lib/sse";
import { acceptsSessionEvent } from "../lib/chat-session";

interface SSEResult {
  connected: boolean;
  reconnecting: boolean;
}

export function useSSE(): SSEResult {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const esRef = useRef<EventStream | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const store = useChatStore;
  const activeSessionId = useChatStore((state) => state.activeThreadId);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const query = activeSessionId ? `?sessionId=${encodeURIComponent(activeSessionId)}` : "";
    const es = createEventStream(`/api/chat/events${query}`);
    esRef.current = es;

    const current = () => esRef.current === es && store.getState().activeThreadId === activeSessionId;
    const on = (type: string, listener: (event: MessageEvent) => void, global = false) => {
      es.addEventListener(type, (event) => {
        if (!current()) return;
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { data = null; }
        if (!acceptsSessionEvent(activeSessionId, data, global)) return;
        if (!global) store.setState((state) => ({ eventVersion: state.eventVersion + 1 }));
        listener(event);
      });
    };

    es.onopen = () => {
      if (!current()) return;
      setConnected(true);
      setReconnecting(false);
    };

    es.onerror = () => {
      if (!current()) return;
      setConnected(false);
      es.close();
      esRef.current = null;

      setReconnecting(true);
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    on("connected", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setProvider(data.provider ?? "");
        store.getState().setModel(data.model ?? "");
      } catch { /* ignore */ }
    }, true);

    on("thinking", () => {
      store.getState().setWaiting(true);
    });

    on("provider", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setProvider(data.provider ?? "");
        store.getState().setModel(data.model ?? "");
      } catch { /* ignore */ }
    }, true);

    on("step_start", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setSteps(
          data.totalSteps ?? 0,
          data.stepNumber ?? 0,
          data.tool ?? ""
        );
      } catch { /* ignore */ }
    });

    on("step_done", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setSteps(
          data.totalSteps ?? 0,
          data.stepNumber ?? 0,
          data.tool ?? ""
        );
      } catch { /* ignore */ }
    });

    on("text_delta", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setWaiting(false);
        store.getState().appendStreamingText(data.text ?? "");
      } catch { /* ignore */ }
    });

    on("text_done", (e) => {
      try {
        const raw = (e as MessageEvent).data;
        const data = JSON.parse(raw);
        const fullText = data.fullText ?? data.text ?? raw;
        store.getState().clearStreaming();
        store.getState().setWaiting(false);
        store.getState().resetSteps();
        store.getState().addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullText,
          timestamp: new Date().toISOString(),
        });

        store.getState().bumpThreadVersion();
      } catch {
        // Always reset busy state even if parsing fails
        store.getState().clearStreaming();
        store.getState().setWaiting(false);
        store.getState().resetSteps();
      }
    });

    on("permission_request", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().addMessage({
          id: data.id ?? crypto.randomUUID(),
          role: "system",
          content: JSON.stringify(data),
          timestamp: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    });

    on("permission_continue", () => {
      // Permission resolved, no special action needed
    });

    on("permission_mode", () => {
      // Informational, no action needed
    });

    on("loop_warning", () => {
      // Could surface a warning in the future
    });

    on("error", (e) => {
      const msg = (e as MessageEvent).data ?? "An error occurred";
      store.getState().setWaiting(false);
      store.getState().clearStreaming();
      store.getState().resetSteps();
      store.getState().addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: msg,
        timestamp: new Date().toISOString(),
      });
    });
  }, [store, activeSessionId]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect]);

  return { connected, reconnecting };
}
