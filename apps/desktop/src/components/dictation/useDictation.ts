import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import { transcribeApi } from "~/api/models";

/**
 * Record from the microphone, then turn it into text with Mercury's speech
 * service. One recording at a time across the app.
 *
 *   idle → (start) → recording → (finish) → transcribing → idle, text delivered
 *                              → (cancel) → idle, nothing kept
 *
 * `needs-setup` when no speech service is configured (the button explains
 * how to add one); `error` for a denied microphone or a failed transcription.
 */

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing" | "needs-setup" | "error";
export type FinishMode = "insert" | "send";

/** Longest single dictation; it stops and transcribes by itself after this. */
const MAX_SECONDS = 5 * 60;
const BARS = 48;

let activeStop: (() => void) | null = null;
let availability: { at: number; available: boolean } | null = null;

/** Best recording format this webview supports (WebKit records mp4, Chromium webm). */
export function pickMimeType(isSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)): string {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"]) if (isSupported(t)) return t;
  return "";
}

/** Plain words for microphone failures. */
export function micErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Mercury isn't allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in or pick one in your system's sound settings.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  return err instanceof Error ? err.message : String(err);
}

export function useDictation(onText: (text: string, mode: FinishMode) => void) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; timer: number; raf: number; mode: FinishMode | "cancel" } | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  // A stable "cancel me" for the one-recording-at-a-time rule.
  const finishRef = useRef<(mode: FinishMode | "cancel") => void>(() => {});
  const stopSelf = useRef(() => finishRef.current("cancel")).current;

  const teardown = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    window.clearInterval(r.timer);
    cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
    rec.current = null;
    if (activeStop === stopSelf) activeStop = null;
  }, [stopSelf]);

  const finish = useCallback((mode: FinishMode | "cancel") => {
    const r = rec.current;
    if (!r) return;
    r.mode = mode;
    if (r.recorder.state !== "inactive") r.recorder.stop();
    else teardown();
  }, [teardown]);
  finishRef.current = finish;

  const start = useCallback(async () => {
    if (rec.current) return;
    setError(null);
    setPhase("starting");
    // Is there a speech service? Asked once a minute at most.
    try {
      if (!availability || Date.now() - availability.at > 60_000) {
        const s = await transcribeApi.status();
        availability = { at: Date.now(), available: s.available };
      }
      if (!availability.available) { setPhase("needs-setup"); return; }
    } catch {
      // Older Mercury without dictation, or offline.
      setError("This Mercury can't transcribe speech yet. Update Mercury to use voice typing.");
      setPhase("error");
      return;
    }
    activeStop?.();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      setError(micErrorText(err));
      setPhase("error");
      return;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const started = Date.now();
    const r = { recorder, stream, ctx, chunks: [] as Blob[], timer: 0, raf: 0, mode: "insert" as FinishMode | "cancel" };
    rec.current = r;
    activeStop = stopSelf;

    let lastPush = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const now = performance.now();
      if (now - lastPush > 70) {
        lastPush = now;
        const level = Math.min(1, (peak / 128) * 2.2);
        setLevels((l) => [...l.slice(1), level]);
      }
      r.raf = requestAnimationFrame(tick);
    };
    r.raf = requestAnimationFrame(tick);
    r.timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) finish("insert");
    }, 250);

    recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
    recorder.onstop = async () => {
      const mode = r.mode;
      const blob = new Blob(r.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      teardown();
      setLevels(Array(BARS).fill(0));
      setSeconds(0);
      if (mode === "cancel") { setPhase("idle"); return; }
      setPhase("transcribing");
      try {
        // No language hint: the service detects it, which handles mixed Urdu/Hindi/English best.
        const { text } = await transcribeApi.send(blob);
        setPhase("idle");
        if (text.trim()) onTextRef.current(text.trim(), mode);
        else { setError("Didn't catch anything. Try again a little closer to the mic."); setPhase("error"); }
      } catch (err) {
        if (err instanceof ApiError && err.data.needs === "speech") { availability = null; setPhase("needs-setup"); return; }
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    };
    recorder.start(1000);
    setSeconds(0);
    setPhase("recording");
  }, [finish, teardown, stopSelf]);

  useEffect(() => () => { const r = rec.current; if (r) { r.mode = "cancel"; try { r.recorder.stop(); } catch { /* already stopped */ } teardown(); } }, [teardown]);

  const dismiss = useCallback(() => { setError(null); setPhase("idle"); }, []);
  return { phase, error, levels, seconds, start, finish, dismiss };
}

export function formatClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
