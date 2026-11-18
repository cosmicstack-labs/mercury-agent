import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_SAMPLES, Pcm16Framer, frameLevel, readWav } from "./pcm";
import {
  CALL_RATE, GEMINI_CONSTRAINED_URL, GEMINI_MODEL, OPENAI_URL, State, audioMessage, b64, finishMessages, finished, geminiSetup,
  onMessage, plan, redact, resample, shouldCommit, type DictationEvent,
} from "./protocol";
import { chooseRoute, LIVE_RETRY_AFTER_MS } from "./route";
import { LiveDictation, type WebSocketLike } from "./stream";
import { DictationText, join } from "./text";

const partial = (text: string): DictationEvent => ({ type: "partial", text });
const final = (text: string): DictationEvent => ({ type: "final", text });

describe("PCM framing", () => {
  it("turns 48 kHz float into 60 ms frames of 16 kHz PCM16", () => {
    const frames: Int16Array[] = [];
    const f = new Pcm16Framer(48_000, (fr) => frames.push(fr.slice()));
    // One second in odd-sized chunks (as a worklet hands them over).
    const sec = new Float32Array(48_000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
    for (let i = 0; i < sec.length; i += 1000) f.push(sec.subarray(i, i + 1000));
    f.flush();
    const total = frames.reduce((n, fr) => n + fr.length, 0);
    expect(total).toBe(16_000);
    expect(frames.slice(0, -1).every((fr) => fr.length === FRAME_SAMPLES)).toBe(true);
    // Amplitude survives (a 440 Hz tone, well under the box filter's cutoff).
    const peak = Math.max(...frames.flatMap((fr) => Array.from(fr, Math.abs)));
    expect(peak).toBeGreaterThan(14_000);
    expect(peak).toBeLessThan(16_500);
  });

  it("keeps the exact rate from 44.1 kHz across chunks", () => {
    let total = 0;
    const f = new Pcm16Framer(44_100, (fr) => { total += fr.length; });
    for (let i = 0; i < 441; i++) f.push(new Float32Array(100)); // 1 s
    f.flush();
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
  });

  it("clips and scales like PCM16", () => {
    const out: Int16Array[] = [];
    const f = new Pcm16Framer(16_000, (fr) => out.push(fr.slice()));
    f.push(new Float32Array([1, -1, 2, -2, 0]));
    f.flush();
    expect(Array.from(out[0])).toEqual([32767, -32768, 32767, -32768, 0]);
    expect(() => new Pcm16Framer(8000, () => {})).toThrow();
    expect(frameLevel(new Int16Array([0, 16384]))).toBe(1);
    expect(frameLevel(new Int16Array(10))).toBe(0);
  });

  it("reads a 16-bit WAV", () => {
    const pcm = new Int16Array([1, -2, 300]);
    const bytes = new Uint8Array(44 + 6);
    const v = new DataView(bytes.buffer);
    const w = (o: number, t: string) => { for (let i = 0; i < 4; i++) bytes[o + i] = t.charCodeAt(i); };
    w(0, "RIFF"); v.setUint32(4, 42, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, 6, true);
    pcm.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
    expect(readWav(bytes)).toEqual({ rate: 16_000, samples: pcm });
  });
});

describe("plans per engine (dictation.rs plans_per_engine, browser sign-in)", () => {
  it("openai: the client secret as a subprotocol", () => {
    const p = plan({ engine: "openai", token: "ek_1" });
    expect(p.url).toBe(OPENAI_URL);
    expect(p.protocols).toEqual(["realtime", "openai-insecure-api-key.ek_1"]);
    expect(p.model).toBe("gpt-live-transcribe");
    expect(plan({ engine: "openai", token: "ek", url: "wss://proxy/v1/realtime?intent=transcription" }).url).toBe("wss://proxy/v1/realtime?intent=transcription");
  });
  it("deepgram: the temporary token as bearer subprotocol", () => {
    const p = plan({ engine: "deepgram", token: "jwt", language: "en" });
    expect(p.url.startsWith("wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=16000")).toBe(true);
    expect(p.url).toContain("interim_results=true");
    expect(p.protocols).toEqual(["bearer", "jwt"]);
    expect(plan({ engine: "deepgram", token: "k" }).url).toContain("language=multi");
    // Odd characters never reach a URL.
    expect(plan({ engine: "deepgram", token: "k", language: "en&x=1" }).url).toContain("language=enx1&");
  });
  it("elevenlabs: the single-use token in the URL", () => {
    const p = plan({ engine: "elevenlabs", token: "sutkn_1" });
    expect(p.url).toContain("model_id=scribe_v2_realtime");
    expect(p.url).toContain("commit_strategy=vad");
    expect(p.url.endsWith("&token=sutkn_1")).toBe(true);
    expect(p.protocols).toEqual([]);
  });
  it("gemini: the ephemeral token on the constrained endpoint", () => {
    const p = plan({ engine: "gemini", token: "auth_tokens/abc" });
    expect(p.url).toBe(`${GEMINI_CONSTRAINED_URL}?access_token=auth_tokens/abc`);
    expect(p.model).toBe(GEMINI_MODEL);
    expect(plan({ engine: "gemini", token: "t&x=1", url: "wss://x/y?alt=1" }).url).toBe("wss://x/y?alt=1&access_token=tx1");
  });
  it("refuses what can't stream", () => {
    expect(() => plan({ engine: "grok" as never, token: "t" })).toThrow(/can't do live dictation/);
    expect(() => plan({ engine: "openai", token: " " })).toThrow(/no dictation token/);
  });
  it("errors never carry a token", () => {
    expect(redact("HTTP 403 for wss://x/y?access_token=auth_tokens/abc")).toBe("HTTP 403 for wss://x/y?…");
    expect(redact("bad ?key=AIza")).toBe("bad ?…");
    expect(redact("x&token=sutkn")).toBe("x&…");
    expect(redact("timed out")).toBe("timed out");
  });
});

describe("engine messages", () => {
  it("openai: partials, then finals strictly in order", () => {
    const st = new State();
    const d = (id: string, t: string) => onMessage("openai", { type: "conversation.item.input_audio_transcription.delta", item_id: id, delta: t }, st);
    const c = (id: string, t: string) => onMessage("openai", { type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: t }, st);
    expect(d("a", " Remind")).toEqual([partial("Remind")]);
    expect(d("a", " me.")).toEqual([partial("Remind me.")]);
    expect(d("b", " And")).toEqual([partial("Remind me. And")]);
    expect(c("b", "And then.")).toEqual([]);
    expect(c("a", "Remind me.")).toEqual([final("Remind me."), final("And then."), partial("")]);
    expect(st.items.pending()).toBe(false);
    d("c", " lost words");
    expect(onMessage("openai", { type: "conversation.item.input_audio_transcription.failed", item_id: "c" }, st)[0]).toEqual(final("lost words"));
    d("d", " tail");
    expect(st.items.flush()).toEqual([final("tail")]);
  });

  it("openai: fatal errors end the stream, an empty commit doesn't", () => {
    const st = new State();
    onMessage("openai", { type: "error", error: { code: "input_audio_buffer_commit_empty", message: "x" } }, st);
    expect(st.fatal).toBeNull();
    onMessage("openai", { type: "error", error: { code: "insufficient_quota", message: "no" } }, st);
    expect(st.fatal).toMatch(/out of credit/);
  });

  it("openai: commits after a 900 ms pause that follows speech", () => {
    const st = new State();
    const quiet = new Int16Array(960);
    const loud = new Int16Array(960).fill(5000);
    for (let i = 0; i < 30; i++) expect(shouldCommit(st, quiet)).toBe(false);
    expect(shouldCommit(st, loud)).toBe(false);
    const commits = Array.from({ length: 20 }, () => shouldCommit(st, quiet));
    expect(commits.filter(Boolean)).toHaveLength(1);
    expect(commits[14] && !commits[13]).toBe(true);
    // Audio goes at 24 kHz for OpenAI.
    const m = JSON.parse(audioMessage("openai", new Int16Array(960)) as string);
    expect(m.type).toBe("input_audio_buffer.append");
    expect(atob(m.audio).length).toBe(1440 * 2);
    expect(finishMessages("openai", new State())).toEqual([]);
  });

  it("gemini: only listens; finish sends quiet, never activityEnd", () => {
    const s = geminiSetup(GEMINI_MODEL);
    expect(s.model).toBe("models/gemini-2.5-flash-native-audio-latest");
    expect(s.inputAudioTranscription).toEqual({});
    expect(s).toMatchObject({ realtimeInputConfig: { automaticActivityDetection: { disabled: true } } });
    for (const k of ["tools", "systemInstruction", "outputAudioTranscription"]) expect(s).not.toHaveProperty(k);
    const m = JSON.parse(audioMessage("gemini", new Int16Array([1, 2])) as string);
    expect(m.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(m.realtimeInput.audio.data).toBe(b64(new Int16Array([1, 2])));
    const fin = finishMessages("gemini", new State());
    expect(fin).toHaveLength(20);
    for (const t of fin) expect(t).toMatch(/"audio"/), expect(t).not.toMatch(/activityEnd|audioStreamEnd/);
  });

  it("gemini: pieces become partials, then sentences", () => {
    const st = new State();
    const t = (piece: string) => onMessage("gemini", { serverContent: { inputTranscription: { text: piece } } }, st);
    expect(t(" Re")).toEqual([partial("Re")]);
    expect(st.gotText).toBe(true);
    expect(t("mind me at 7")).toEqual([partial("Remind me at 7")]);
    expect(t(":3")).toEqual([partial("Remind me at 7:3")]);
    expect(t("0.")).toEqual([partial("Remind me at 7:30.")]);
    expect(t(" And")).toEqual([final("Remind me at 7:30."), partial("And")]);
    expect(t(" pay 3.5")).toEqual([partial("And pay 3.5")]);
    st.gotText = false;
    expect(onMessage("gemini", { setupComplete: {} }, st)).toEqual([]);
    expect(onMessage("gemini", { serverContent: { modelTurn: { parts: [] } } }, st)).toEqual([]);
    expect(st.gotText).toBe(false);
    expect(st.fatal).toBeNull();
  });

  it("deepgram: interims and finals", () => {
    const st = new State();
    const r = (t: string, fin: boolean) => onMessage("deepgram", { type: "Results", is_final: fin, channel: { alternatives: [{ transcript: t }] } }, st);
    expect(r("book a", false)).toEqual([partial("book a")]);
    expect(r("book a", false)).toEqual([]);
    expect(r("Book a table.", true)).toEqual([final("Book a table.")]);
    expect(r("", true)).toEqual([partial("")]);
    expect(finished("deepgram", st)).toBe(false);
    onMessage("deepgram", { type: "Metadata" }, st);
    expect(finished("deepgram", st)).toBe(true);
    onMessage("deepgram", { type: "Error", description: "bad token" }, st);
    expect(st.fatal).toBe("Deepgram: bad token");
    expect(audioMessage("deepgram", new Int16Array([1, -1]))).toEqual(new Uint8Array([1, 0, 255, 255]));
    expect(finishMessages("deepgram", st).map((m) => JSON.parse(m as string).type)).toEqual(["Finalize", "CloseStream"]);
  });

  it("elevenlabs: partials and commits", () => {
    const st = new State();
    const m = (kind: string, t: string) => onMessage("elevenlabs", { message_type: kind, text: t }, st);
    expect(m("session_started", "")).toEqual([]);
    expect(m("partial_transcript", "hello th")).toEqual([partial("hello th")]);
    expect(m("committed_transcript", "Hello there.")).toEqual([final("Hello there.")]);
    expect(m("committed_transcript_with_timestamps", "Hello there.")).toEqual([]);
    onMessage("elevenlabs", { message_type: "auth_error", error: "invalid token" }, st);
    expect(st.fatal).toBe("ElevenLabs: invalid token");
    const chunk = JSON.parse(audioMessage("elevenlabs", new Int16Array([5])) as string);
    expect(chunk).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: CALL_RATE });
    expect(JSON.parse(finishMessages("elevenlabs", st)[0] as string)).toMatchObject({ commit: true, audio_base_64: "" });
  });

  it("resamples linearly like the Rust engine", () => {
    expect(Array.from(resample(new Int16Array([0, 300]), 16_000, 24_000))).toEqual([0, 200, 300]);
    expect(resample(new Int16Array(960), 16_000, 24_000)).toHaveLength(1440);
  });
});

describe("the message box (the phones' DictationText, with a cursor)", () => {
  it("partials then finals go after what was typed", () => {
    const t = new DictationText("Note:");
    let box = t.partial("remind me", "Note:");
    expect(box).toBe("Note: remind me");
    box = t.partial("Remind me to call", box);
    expect(box).toBe("Note: Remind me to call");
    box = t.final("Remind me to call the plumber.", box);
    expect(box).toBe("Note: Remind me to call the plumber.");
    box = t.partial("And book", box);
    expect(box).toBe("Note: Remind me to call the plumber. And book");
    box = t.final("And book a table.", box);
    expect(box).toBe("Note: Remind me to call the plumber. And book a table.");
    expect(t.partial("", box)).toBe(box);
  });

  it("spacing", () => {
    expect(new DictationText("").partial("hello", "")).toBe("hello");
    expect(new DictationText("List:\n").final("milk", "List:\n")).toBe("List:\nmilk");
    expect(new DictationText("Hi ").partial("there", "Hi ")).toBe("Hi there");
    expect(join("call me", ", please")).toBe("call me, please");
    expect(join("call me", "later")).toBe("call me later");
  });

  it("the owner's edits win", () => {
    const t = new DictationText("");
    let box = t.final("Book a table.", "");
    box = t.partial("for four", box);
    expect(box).toBe("Book a table. for four");
    box = t.partial("for four people", "Book a table at Roma. for four");
    expect(box).toBe("Book a table at Roma. for four people");
    expect(t.final("Thanks.", "")).toBe("Thanks.");
  });

  it("goes in at the cursor and keeps what follows it", () => {
    const draft = "Call  at noon";
    const t = new DictationText(draft, 5);
    let box = t.partial("the plum", draft);
    expect(box).toBe("Call the plum at noon");
    box = t.final("the plumber", box);
    expect(box).toBe("Call the plumber at noon");
    expect(t.cursor).toBe("Call the plumber".length);
    // An edit before the spoken words keeps what follows the cursor at the end.
    box = t.partial("now", "Please call the plumber at noon");
    expect(box).toBe("Please call the plumber now at noon");
    // Nothing spoken yet: the box is untouched.
    expect(new DictationText("ab", 1).partial("", "ab")).toBe("ab");
  });
});

describe("live or batch", () => {
  const caps = { dictation: true, dictationEngine: "gemini", dictationEngineName: "Gemini" };
  it("streams when Mercury's speech service can", () => {
    expect(chooseRoute({ caps, wantsLive: true, canStream: true })).toEqual({ kind: "live", engine: "gemini", name: "Gemini" });
  });
  it("records and transcribes otherwise", () => {
    expect(chooseRoute({ caps: null, wantsLive: true, canStream: true }).kind).toBe("batch"); // older Mercury
    expect(chooseRoute({ caps: { dictation: false }, wantsLive: true, canStream: true }).kind).toBe("batch");
    expect(chooseRoute({ caps: { dictation: true, dictationEngine: "whisper" }, wantsLive: true, canStream: true }).kind).toBe("batch");
    expect(chooseRoute({ caps, wantsLive: false, canStream: true }).kind).toBe("batch");
    expect(chooseRoute({ caps, wantsLive: true, canStream: false }).kind).toBe("batch");
  });
  it("after a stream fails to connect, records for a while", () => {
    const now = 1_000_000;
    expect(chooseRoute({ caps, wantsLive: true, canStream: true, liveFailedAt: now - 1000, now }).kind).toBe("batch");
    expect(chooseRoute({ caps, wantsLive: true, canStream: true, liveFailedAt: now - LIVE_RETRY_AFTER_MS - 1, now }).kind).toBe("live");
  });
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  binaryType = "blob";
  readyState = 0;
  sent: (string | ArrayBufferView | ArrayBuffer)[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string, readonly protocols?: string[]) { FakeSocket.last = this; }
  send(d: string | ArrayBufferView | ArrayBuffer) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(v: unknown, binary = false) { const s = JSON.stringify(v); this.onmessage?.({ data: binary ? new TextEncoder().encode(s).buffer : s }); }
}

describe("the stream", () => {
  afterEach(() => vi.useRealTimers());

  it("gemini: setup, then audio kept from before it was ready, then settles on finish", () => {
    vi.useFakeTimers();
    const events: DictationEvent[] = [];
    const s = new LiveDictation({ engine: "gemini", token: "auth_tokens/x" }, (e) => events.push(e), { WebSocket: FakeSocket });
    const ws = FakeSocket.last;
    expect(ws.binaryType).toBe("arraybuffer");
    s.pushAudio(new Int16Array(960).fill(7));
    ws.open();
    expect(JSON.parse(ws.sent[0] as string).setup.model).toBe(`models/${GEMINI_MODEL}`);
    expect(ws.sent).toHaveLength(1); // audio waits for setupComplete
    ws.recv({ setupComplete: {} }, true);
    expect(ws.sent[1]).toBe(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    expect(JSON.parse(ws.sent[2] as string).realtimeInput.audio.data).toBe(b64(new Int16Array(960).fill(7)));
    ws.recv({ serverContent: { inputTranscription: { text: " testing live" } } }, true);
    s.finish();
    expect(ws.sent.slice(3)).toHaveLength(20);
    vi.advanceTimersByTime(1000);
    ws.recv({ serverContent: { inputTranscription: { text: " dictation" } } }, true);
    vi.advanceTimersByTime(2400);
    expect(events.some((e) => e.type === "closed")).toBe(false);
    vi.advanceTimersByTime(400);
    expect(events).toEqual([partial("testing live"), partial("testing live dictation"), final("testing live dictation"), { type: "closed", reason: "stopped" }]);
    expect(ws.closed).toBe(true);
  });

  it("deepgram: signs in with the bearer subprotocol and ends on Metadata", () => {
    vi.useFakeTimers();
    const events: DictationEvent[] = [];
    const s = new LiveDictation({ engine: "deepgram", token: "jwt" }, (e) => events.push(e), { WebSocket: FakeSocket });
    const ws = FakeSocket.last;
    expect(ws.protocols).toEqual(["bearer", "jwt"]);
    ws.open();
    s.pushAudio(new Int16Array([1]));
    expect(ws.sent[0]).toEqual(new Uint8Array([1, 0]));
    vi.advanceTimersByTime(5000);
    expect(ws.sent[1]).toBe(JSON.stringify({ type: "KeepAlive" }));
    ws.recv({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hello" }] } });
    s.finish();
    ws.recv({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "Hello." }] } });
    ws.recv({ type: "Metadata" });
    expect(events).toEqual([partial("hello"), final("Hello."), { type: "closed", reason: "stopped" }]);
  });

  it("a refused connection says so, without the token", () => {
    const events: DictationEvent[] = [];
    new LiveDictation({ engine: "gemini", token: "auth_tokens/x" }, (e) => events.push(e), { WebSocket: FakeSocket });
    FakeSocket.last.onclose?.({ code: 1008, reason: "bad wss://x?access_token=auth_tokens/x" });
    expect(events).toEqual([{ type: "closed", reason: "Gemini refused dictation: bad wss://x?…" }]);
  });

  it("cancel drops what was heard", () => {
    const events: DictationEvent[] = [];
    const s = new LiveDictation({ engine: "elevenlabs", token: "t" }, (e) => events.push(e), { WebSocket: FakeSocket });
    FakeSocket.last.open();
    FakeSocket.last.recv({ message_type: "partial_transcript", text: "hi" });
    s.cancel();
    expect(events).toEqual([partial("hi"), { type: "closed", reason: "cancelled" }]);
  });
});
