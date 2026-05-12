import { useEffect, useRef, useCallback, useState } from "react";
import { useChatStore } from "@/stores/chat";

interface SSEResult {
  connected: boolean;
  reconnecting: boolean;
}

export function useSSE(): SSEResult {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const store = useChatStore;

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource("/api/chat/events");
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setReconnecting(false);
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      setReconnecting(true);
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    es.addEventListener("connected", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setProvider(data.provider ?? "");
        store.getState().setModel(data.model ?? "");
      } catch { /* ignore */ }
    });

    es.addEventListener("thinking", () => {
      store.getState().setWaiting(true);
    });

    es.addEventListener("provider", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setProvider(data.provider ?? "");
        store.getState().setModel(data.model ?? "");
      } catch { /* ignore */ }
    });

    es.addEventListener("step_start", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setSteps(
          data.totalSteps ?? 0,
          data.stepNumber ?? 0,
          data.tool ?? ""
        );
      } catch { /* ignore */ }
    });

    es.addEventListener("step_done", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.getState().setSteps(
          data.totalSteps ?? 0,
          data.stepNumber ?? 0,
          data.tool ?? ""
        );
      } catch { /* ignore */ }
    });

    es.addEventListener("text_delta", (e) => {
      const text = (e as MessageEvent).data;
      store.getState().setWaiting(false);
      store.getState().appendStreamingText(text);
    });

    es.addEventListener("text_done", (e) => {
      const fullText = (e as MessageEvent).data;
      store.getState().clearStreaming();
      store.getState().setWaiting(false);
      store.getState().resetSteps();
      store.getState().addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: fullText,
        timestamp: new Date().toISOString(),
      });
    });

    es.addEventListener("permission_request", (e) => {
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

    es.addEventListener("permission_continue", () => {
      // Permission resolved, no special action needed
    });

    es.addEventListener("permission_mode", () => {
      // Informational, no action needed
    });

    es.addEventListener("loop_warning", () => {
      // Could surface a warning in the future
    });

    es.addEventListener("error", (e) => {
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
  }, [store]);

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
