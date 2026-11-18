import type { VoiceCapabilities } from "~/api/models";
import { isLiveEngine, type LiveEngine } from "./protocol";

/**
 * Live or batch? Live streaming (words in the box as they're spoken) when the
 * Mercury can mint a token for a speech service that streams, the box takes
 * live text, and the webview can open sockets and tap the mic; otherwise the
 * recorder records and Mercury transcribes after the stop (/api/transcribe).
 */
export type DictationRoute = { kind: "live"; engine: LiveEngine; name: string } | { kind: "batch" };

/** After a live stream fails to connect, the mic records instead for this long. */
export const LIVE_RETRY_AFTER_MS = 5 * 60_000;

export function chooseRoute(opts: {
  caps: Pick<VoiceCapabilities, "dictation" | "dictationEngine" | "dictationEngineName"> | null;
  wantsLive: boolean;
  /** WebSocket, AudioContext and getUserMedia are there. */
  canStream: boolean;
  liveFailedAt?: number | null;
  now?: number;
}): DictationRoute {
  const { caps, wantsLive, canStream, liveFailedAt } = opts;
  if (!wantsLive || !canStream || !caps?.dictation || !isLiveEngine(caps.dictationEngine)) return { kind: "batch" };
  if (liveFailedAt && (opts.now ?? Date.now()) - liveFailedAt < LIVE_RETRY_AFTER_MS) return { kind: "batch" };
  return { kind: "live", engine: caps.dictationEngine, name: caps.dictationEngineName || caps.dictationEngine };
}

export function canStreamHere(): boolean {
  return typeof WebSocket !== "undefined" && typeof AudioContext !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}
