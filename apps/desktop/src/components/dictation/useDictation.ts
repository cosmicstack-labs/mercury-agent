import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import { liveDictationApi, transcribeApi, type VoiceCapabilities } from "~/api/models";
import { startMic, type MicCapture } from "./live/mic";
import { frameLevel } from "./live/pcm";
import { isLiveEngine, type DictationEvent } from "./live/protocol";
import { canStreamHere, chooseRoute } from "./live/route";
import { LiveDictation } from "./live/stream";
import { DictationText } from "./live/text";

/**
 * Record from the microphone, then turn it into text with Mercury's speech
 * service. One recording at a time across the app.
 *
 *   idle → (start) → recording → (finish) → transcribing → idle, text delivered
 *                              → (cancel) → idle, nothing kept
 *
 * `needs-setup` when no speech service is configured (the button explains
 * how to add one); `error` for a denied microphone or a failed transcription.
 *
 * Live dictation (a box that passes `live`, like the chat composer): when the
 * Mercury's speech service streams (GET /api/mobile/voice/capabilities: Gemini,
 * OpenAI, Deepgram or ElevenLabs), the words appear in the box at the cursor as
 * they're spoken, on a short-lived token Mercury mints (never a key):
 *
 *   idle → (start) → starting → listening → (finish) → finishing → idle
 *
 * The mic starts at once, while the token and the stream come up; what's said
 * meanwhile is kept. Esc or the mic stops it, sending stops it, and a minute of
 * quiet stops it. With no streaming service, a failed token or a stream that
 * couldn't connect, the same mic records and transcribes after the stop.
 */

export type DictationPhase = "idle" | "starting" | "recording" | "listening" | "finishing" | "transcribing" | "needs-setup" | "error";
export type FinishMode = "insert" | "send";

/** The box live words go into: read it (with the cursor) and write it. */
export interface LiveTarget {
  get: () => { text: string; cursor: number };
  set: (text: string, cursor: number) => void;
}

/** Quiet this long while listening stops live dictation. */
export const SILENCE_LIMIT_MS = 60_000;
/** Longest live dictation (Gemini Live sessions end at about 15 minutes). */
const MAX_LIVE_SECONDS = 10 * 60;

/** Longest single dictation; it stops and transcribes by itself after this. */
const MAX_SECONDS = 5 * 60;
const BARS = 48;

let activeStop: (() => void) | null = null;
let availability: { at: number; available: boolean } | null = null;
let liveCaps: { at: number; caps: VoiceCapabilities | null } | null = null;
let liveFailedAt: number | null = null;

/** Capabilities, asked once a minute at most; null for a Mercury without live dictation. */
async function capabilities(): Promise<VoiceCapabilities | null> {
  if (liveCaps && Date.now() - liveCaps.at < 60_000) return liveCaps.caps;
  const caps = await liveDictationApi.capabilities().catch(() => null);
  liveCaps = { at: Date.now(), caps };
  return caps;
}

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

export function useDictation(onText: (text: string, mode: FinishMode) => void, live?: LiveTarget) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  /** Who's listening while live ("Gemini"). */
  const [engineName, setEngineName] = useState<string | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const session = useRef<{ mic: MicCapture | null; stream: LiveDictation | null; held: Int16Array[]; text: DictationText; timer: number; lastHeard: number; started: number; gen: number; got: boolean; quiet: boolean; stoppedAt: number } | null>(null);
  const gen = useRef(0);
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

  /** Live: the mic and timers off; the stream is left to finish or is already gone. */
  const liveTeardown = useCallback(() => {
    const l = session.current;
    if (!l) return;
    window.clearInterval(l.timer);
    l.mic?.stop();
    l.mic = null;
    session.current = null;
    if (activeStop === stopSelf) activeStop = null;
    setLevels(Array(BARS).fill(0));
    setSeconds(0);
    setEngineName(null);
  }, [stopSelf]);

  const finish = useCallback((mode: FinishMode | "cancel") => {
    const l = session.current;
    if (l) {
      // Live. Stop the mic; "insert" (Esc, the mic) waits for the last words, "cancel" (sending) doesn't.
      l.mic?.stop();
      l.mic = null;
      if (mode === "cancel") {
        gen.current++;
        l.stream?.cancel();
        liveTeardown();
        setPhase("idle");
        return;
      }
      l.stoppedAt = Date.now();
      setPhase("finishing");
      // Still waiting for the token: the stream finishes as soon as it opens.
      l.stream?.finish();
      return;
    }
    const r = rec.current;
    if (!r) return;
    r.mode = mode;
    if (r.recorder.state !== "inactive") r.recorder.stop();
    else teardown();
  }, [teardown, liveTeardown]);
  finishRef.current = finish;

  /** Live text into the box: partials replace each other, finals stay. */
  const onLiveEvent = useCallback((e: DictationEvent, g: number) => {
    const l = session.current;
    if (g !== gen.current || !l) return;
    const target = liveRef.current;
    if (e.type === "closed") {
      gen.current++;
      liveTeardown();
      if (e.reason === "stopped" && l.quiet) { setError("Dictation stopped after a minute of quiet."); setPhase("error"); return; }
      if (e.reason === "stopped" || e.reason === "cancelled") { setPhase("idle"); return; }
      // Couldn't connect at all: record and transcribe instead for a while.
      if (!l.got) liveFailedAt = Date.now();
      setError(`Live dictation stopped: ${e.reason}.`);
      setPhase("error");
      return;
    }
    if (!target) return;
    const cur = target.get().text;
    const next = e.type === "partial" ? l.text.partial(e.text, cur) : l.text.final(e.text, cur);
    if (e.text) { l.lastHeard = Date.now(); l.got = true; }
    if (next !== cur) target.set(next, l.text.cursor);
  }, [liveTeardown]);

  /** Live: mic now, token and stream in parallel; false when it should record instead. */
  const startLive = useCallback(async (engine: string, name: string): Promise<boolean> => {
    const target = liveRef.current;
    if (!target) return false;
    const g = ++gen.current;
    const box = target.get();
    const l = { mic: null as MicCapture | null, stream: null as LiveDictation | null, held: [] as Int16Array[], text: new DictationText(box.text, box.cursor), timer: 0, lastHeard: Date.now(), started: Date.now(), gen: g, got: false, quiet: false, stoppedAt: 0 };
    session.current = l;
    activeStop = stopSelf;
    setEngineName(name);
    let lastPush = 0;
    const onFrame = (frame: Int16Array) => {
      if (session.current !== l) return;
      const level = frameLevel(frame);
      if (level > 0.08) l.lastHeard = Date.now();
      const now = performance.now();
      if (now - lastPush > 55) { lastPush = now; setLevels((v) => [...v.slice(1), level]); }
      if (l.stream) l.stream.pushAudio(frame);
      else if (l.held.length < 250) l.held.push(frame);
    };
    const token = liveDictationApi.token(engine).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)));
    try {
      l.mic = await startMic(onFrame);
    } catch (err) {
      gen.current++;
      liveTeardown();
      setError(micErrorText(err));
      setPhase("error");
      return true;
    }
    if (session.current !== l) { l.mic.stop(); return true; }
    // Stopped while the mic came up: what was said goes to the stream once it opens.
    if (l.stoppedAt) { l.mic.stop(); l.mic = null; } else setPhase("listening");
    setSeconds(0);
    l.timer = window.setInterval(() => {
      if (session.current !== l) return;
      const s = Math.floor((Date.now() - l.started) / 1000);
      if (l.stoppedAt) {
        // The engine never confirmed the stop (Gemini can take ~10 s to settle a long dictation): give up waiting.
        if (Date.now() - l.stoppedAt > 15_000) { gen.current++; l.stream?.cancel(); liveTeardown(); setPhase("idle"); }
        return;
      }
      setSeconds(s);
      if (Date.now() - l.lastHeard >= SILENCE_LIMIT_MS) { l.quiet = true; finishRef.current("insert"); }
      else if (s >= MAX_LIVE_SECONDS) finishRef.current("insert");
    }, 250);
    const t = await token;
    if (session.current !== l) return true;
    if (t instanceof Error || !isLiveEngine(t.engine)) {
      // No token (the key was removed, the service refused): record and transcribe instead,
      // unless the owner already stopped (then say why nothing came).
      const stopped = !!l.stoppedAt;
      gen.current++;
      l.mic?.stop();
      l.mic = null;
      liveTeardown();
      liveCaps = null;
      if (!stopped) return false;
      setError(`Live dictation couldn't start${t instanceof Error ? `: ${t.message}` : "."}`);
      setPhase("error");
      return true;
    }
    try {
      l.stream = new LiveDictation({ engine: t.engine, token: t.token, model: t.model, url: t.url, language: t.language }, (e) => onLiveEvent(e, g));
    } catch (err) {
      gen.current++;
      liveTeardown();
      liveFailedAt = Date.now();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      return true;
    }
    for (const f of l.held) l.stream.pushAudio(f);
    l.held = [];
    // Stopped while the token came: finish with what was said.
    if (l.stoppedAt) l.stream.finish();
    return true;
  }, [liveTeardown, onLiveEvent, stopSelf]);

  const start = useCallback(async () => {
    if (rec.current || session.current) return;
    setError(null);
    setPhase("starting");
    if (liveRef.current) {
      const caps = await capabilities();
      const route = chooseRoute({ caps, wantsLive: true, canStream: canStreamHere(), liveFailedAt });
      if (route.kind === "live") {
        activeStop?.();
        if (await startLive(route.engine, route.name)) return;
        setPhase("starting");
      }
    }
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
  }, [finish, teardown, stopSelf, startLive]);

  useEffect(() => () => {
    const r = rec.current;
    if (r) { r.mode = "cancel"; try { r.recorder.stop(); } catch { /* already stopped */ } teardown(); }
    const l = session.current;
    if (l) { gen.current++; l.mic?.stop(); l.stream?.cancel(); liveTeardown(); }
  }, [teardown, liveTeardown]);

  const dismiss = useCallback(() => { setError(null); setPhase("idle"); }, []);
  /** Live words are going into the box (or the last ones are on their way). */
  const liveActive = phase === "listening" || phase === "finishing" || (phase === "starting" && engineName !== null);
  return { phase, error, levels, seconds, start, finish, dismiss, engineName, liveActive };
}

export function formatClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
