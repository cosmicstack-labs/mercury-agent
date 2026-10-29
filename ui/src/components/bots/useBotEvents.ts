import { useEffect, useState, useRef } from "react";
import { createEventStream, type EventStream } from "@/lib/sse";

/**
 * Live fleet feed — one event stream per mounted cockpit. Rides the same
 * in-process activity bus as the CLI's bot-thread live region, so what the
 * dashboard shows is what the bot is doing right now. The stream reconnects
 * by itself; components keep their periodic roster poll as the fallback.
 */
export interface BotEventState {
  /** botId → current activity label ("read_file …","fetch_url …"). */
  activity: Record<string, string>;
  /** Newest delivered artifact — the deliverables inbox banners + refreshes live on this. */
  lastDelivery: { botId: string; name: string; at: number } | null;
  connected: boolean;
}

export function useBotEvents(): BotEventState {
  const [state, setState] = useState<BotEventState>({
    activity: {},
    lastDelivery: null,
    connected: false,
  });
  const esRef = useRef<EventStream | null>(null);

  useEffect(() => {
    const es = createEventStream("/api/bots/events");
    esRef.current = es;

    es.addEventListener("bot_activity", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as {
          botId: string;
          kind: "turn-start" | "step" | "tool" | "turn-end" | "thinking";
          label: string;
        };
        // 'thinking' events carry the live stream tail for threads/chattier
        // surfaces; the dashboard roster wants semantic work labels only.
        if (ev.kind === "thinking") return;
        // A delivered artifact is the moment the owner reacts to — it banners
        // the inbox AND refreshes its list. Otherwise it's a roster activity label.
        if (ev.kind === "tool" && ev.label.startsWith("Delivered ")) {
          const name = ev.label.replace(/^Delivered /, "");
          setState((prev) => ({
            ...prev,
            activity: { ...prev.activity, [ev.botId]: ev.label },
            lastDelivery: { botId: ev.botId, name, at: Date.now() },
          }));
          return;
        }
        setState((prev) => {
          const activity = { ...prev.activity };
          if (ev.kind === "turn-end") {
            delete activity[ev.botId];
          } else {
            activity[ev.botId] = ev.label;
          }
          return { ...prev, activity };
        });
      } catch {}
    });

    es.onopen = () => setState((p) => ({ ...p, connected: true }));
    es.onerror = () => setState((p) => ({ ...p, connected: false }));

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return state;
}