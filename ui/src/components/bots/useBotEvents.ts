import { useEffect, useState, useRef } from "react";

/**
 * Live fleet feed — one EventSource per mounted cockpit. Rides the same
 * in-process activity bus as the CLI's bot-thread live region, so what the
 * dashboard shows is what the bot is doing right now. EventSource reconnects
 * natively; components keep their periodic roster poll as the fallback.
 */
export interface BotEventState {
  /** botId → current activity label ("read_file …","fetch_url …"). */
  activity: Record<string, string>;
  /** Newest delivered artifact — the deliverables inbox banners + refreshes live on this. */
  lastDelivery: { botId: string; name: string; at: number } | null;
  /**
   * Bumped on every `bot_roster` frame — the core re-broadcasts the roster when an avatar
   * changes, which is how a face set on the phone reaches an open dashboard. Used as the
   * cache-buster of each `<img>`; the periodic poll stays the fallback.
   */
  rosterSeq: number;
  connected: boolean;
}

export function useBotEvents(): BotEventState {
  const [state, setState] = useState<BotEventState>({
    activity: {},
    lastDelivery: null,
    rosterSeq: 0,
    connected: false,
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`${window.location.origin}/api/bots/events`);
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

    es.addEventListener("bot_roster", () => {
      setState((prev) => ({ ...prev, rosterSeq: prev.rosterSeq + 1 }));
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