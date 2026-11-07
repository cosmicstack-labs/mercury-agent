/* ═══════════════════════════════════════════════════════════════
   Optimus voice, from the runtime's /api/voice feed. The main window
   streams it, mirrors it to the notch capsule, and turns the capsule's
   buttons into /api/voice/control calls.
   ═══════════════════════════════════════════════════════════════ */

import { useEffect } from "react";
import { create } from "zustand";
import { http } from "~/api/client";
import { openStream } from "~/api/stream";
import { isTauri } from "~/shell/tauri";

export type VoiceAction = "start" | "mute" | "unmute" | "interrupt" | "stop";

export interface VoiceTurn {
  id: number;
  /** result: the full answer behind what Mercury said out loud. */
  role: "owner" | "mercury" | "result" | "activity" | "approval" | "system";
  text: string;
  at: number;
}

export interface VoiceState {
  available: boolean;
  plugin: string | null;
  active: boolean;
  callId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  listening: boolean;
  speaking: boolean;
  working: boolean;
  muted: boolean;
  thinking: boolean;
  activity: string | null;
  outcome: string | null;
  /** The chat thread this call is being saved to, live. */
  threadId?: string | null;
  turns: VoiceTurn[];
}

export type VoicePhase = "off" | "listening" | "speaking" | "thinking" | "working" | "muted";

export function phaseOf(s: Pick<VoiceState, "active" | "listening" | "speaking" | "thinking" | "working" | "muted">): VoicePhase {
  if (!s.active) return "off";
  if (s.muted) return "muted";
  if (s.speaking) return "speaking";
  if (s.working) return "working";
  if (s.thinking) return "thinking";
  return "listening";
}

export const PHASE_LABEL: Record<VoicePhase, string> = {
  off: "Optimus",
  listening: "Listening",
  speaking: "Speaking",
  thinking: "Thinking",
  working: "Working",
  muted: "Muted",
};

const EMPTY: VoiceState = {
  available: false, plugin: null, active: false, callId: null, startedAt: null, endedAt: null,
  listening: false, speaking: false, working: false, muted: false, thinking: false, activity: null, outcome: null, threadId: null, turns: [],
};

export const useVoice = create<VoiceState & { supported: boolean }>(() => ({ ...EMPTY, supported: true }));

export async function voiceControl(action: VoiceAction): Promise<void> {
  await http.post("/api/voice/control", { action });
}

/** How loud you (mic) and Mercury (out) are right now, 0-1. Updated ~12×/s; read in animation frames, not renders. */
export const useVoiceLevels = create<{ mic: number; out: number; at: number }>(() => ({ mic: 0, out: 0, at: 0 }));

/**
 * The call screen: full window, or a small floating pill while you do
 * other things. `starting` covers the moment between pressing call and
 * Optimus answering; `error` when it couldn't start.
 */
export const useCall = create<{ view: "full" | "mini"; starting: boolean; error: string | null }>(() => ({ view: "mini", starting: false, error: null }));

/** Start a call from the app: opens the call screen and asks Optimus to start listening. */
export async function startCall(): Promise<void> {
  if (useVoice.getState().active) { useCall.setState({ view: "full" }); return; }
  useCall.setState({ view: "full", starting: true, error: null });
  try {
    await voiceControl("start");
  } catch (e) {
    useCall.setState({ starting: false, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  // Optimus answers in a second or two; if nothing comes, say so instead of waiting forever.
  setTimeout(() => {
    const c = useCall.getState();
    if (c.starting && !useVoice.getState().active) {
      useCall.setState({ starting: false, error: "Optimus didn't start listening. Check Settings → Voice (engine and key) and that the microphone is allowed for Optimus." });
    }
  }, 12_000);
}

/** Called on every new line of a call (the chat view refreshes the call's thread if it's open). */
let onCallTurn: ((threadId: string | null) => void) | null = null;
export function setOnCallTurn(fn: ((threadId: string | null) => void) | null): void { onCallTurn = fn; }

/** Main window: stream the feed, mirror it to the capsule, show/hide the capsule. */
export function useVoiceFeed(connectionId: string): void {
  useEffect(() => {
    let closed = false;
    void http.get<VoiceState>("/api/voice")
      .then((s) => { if (!closed) useVoice.setState({ ...s, supported: true }); })
      .catch(() => { if (!closed) useVoice.setState({ ...EMPTY, supported: false }); });
    const stream = openStream("/api/voice/events", {
      onEvent: (event, raw) => {
        try {
          const data = JSON.parse(raw);
          if (event === "state") {
            const { turns, ...rest } = data as VoiceState;
            const was = useVoice.getState();
            useVoice.setState((s) => ({ ...s, ...rest, turns: Array.isArray(turns) ? turns : rest.active && !s.active ? [] : s.turns, supported: true }));
            if (rest.active && !was.active) useCall.setState((c) => ({ starting: false, error: null, view: c.starting ? "full" : c.view }));
            if (!rest.active && was.active) {
              useVoiceLevels.setState({ mic: 0, out: 0, at: Date.now() });
              const failed = typeof rest.outcome === "string" && rest.outcome.startsWith("failed");
              useCall.setState({ starting: false, error: failed ? `The call couldn't continue: ${rest.outcome!.replace(/^failed:?\s*/, "")}` : null });
            }
          } else if (event === "turn") {
            useVoice.setState((s) => ({ turns: [...s.turns.filter((t) => t.id !== (data as VoiceTurn).id), data as VoiceTurn].slice(-200) }));
            onCallTurn?.(useVoice.getState().threadId ?? null);
          } else if (event === "level") {
            useVoiceLevels.setState(data as { mic: number; out: number; at: number });
          }
        } catch { /* ignore a bad frame */ }
      },
    });
    return () => { closed = true; stream.close(); };
  }, [connectionId]);

  // The capsule: shown while a session runs, given every change.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let shown = false;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { emitTo, listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ action: VoiceAction }>("voice-control", (e) => { void voiceControl(e.payload.action).catch(() => {}); });
      const push = async (s: VoiceState) => {
        if (s.active && !shown) { shown = true; await invoke("notch_show", { width: 440, height: 52 }).catch(() => {}); }
        if (!s.active && shown) { shown = false; await invoke("notch_hide").catch(() => {}); }
        if (s.active) await emitTo("notch", "voice-state", { ...s, turns: s.turns.slice(-3) }).catch(() => {});
      };
      const off = useVoice.subscribe((s) => { void push(s); });
      const prev = unlisten;
      unlisten = () => { off(); prev?.(); };
      void push(useVoice.getState());
    })();
    return () => { unlisten?.(); };
  }, []);
}
