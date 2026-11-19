/**
 * Live dictation, the wire protocols: a TypeScript port of the phones' engine
 * (crates/mercury-voice/src/dictation.rs). Pure functions, no sockets; the
 * stream (stream.ts) drives them.
 *
 * Engines (each with a short-lived token Mercury mints: POST /api/mobile/voice/dictation):
 * - openai: a Realtime transcription session (`?intent=transcription`), `gpt-live-transcribe`.
 *   That model has no server VAD, so the client commits a segment after a pause.
 * - gemini: a Gemini Live session that only listens (activity detection off, one
 *   `activityStart` never ended, `inputAudioTranscription`), on the constrained
 *   endpoint the ephemeral token works on. Finish sends quiet and waits for the
 *   transcript to settle (never activityEnd/audioStreamEnd: either makes it answer).
 * - deepgram: `/v1/listen` streaming with interim results (Nova-3).
 * - elevenlabs: Scribe realtime with VAD commits.
 *
 * Signing in from a webview: a browser WebSocket can't set headers, so where the
 * Rust client sends `Authorization`, this one uses what each service accepts from
 * a browser: OpenAI the `openai-insecure-api-key.<secret>` subprotocol (with the
 * minted client secret, never a key), Deepgram the `bearer, <token>` subprotocol
 * (its temporary JWT), ElevenLabs `&token=` and Gemini `?access_token=` in the URL.
 *
 * Events: `partial` is the whole not-yet-final text (it replaces the previous
 * partial); `final` is a finished piece, in order (it replaces the partial it
 * came from); `closed` ends the stream ("stopped" after finish).
 */

export type LiveEngine = "openai" | "gemini" | "deepgram" | "elevenlabs";

export type DictationEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "closed"; reason: string };

export const CALL_RATE = 16_000;
export const OPENAI_MODEL = "gpt-live-transcribe";
export const DEEPGRAM_MODEL = "nova-3";
export const ELEVENLABS_MODEL = "scribe_v2_realtime";
export const GEMINI_MODEL = "gemini-2.5-flash-native-audio-latest";
export const OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const GEMINI_CONSTRAINED_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/** OpenAI's live model: commit a segment after this much quiet following speech. */
export const COMMIT_AFTER_QUIET_MS = 900;
/** A frame louder than this (peak, PCM16) counts as speech. */
export const SPEECH_PEAK = 1200;
/** How long finish waits for the last final text. */
export const FINISH_WAIT_MS = 4000;
/** Gemini: quiet sent on finish so the last words are transcribed. */
export const GEMINI_FLUSH_MS = 2000;
/** Gemini: after finish, the transcript is complete once nothing new came for this long. */
export const GEMINI_SETTLE_MS = 2500;
/** Gemini: the longest finish waits. */
export const GEMINI_FINISH_WAIT_MS = 10_000;

export const ENGINE_LABELS: Record<LiveEngine, string> = { openai: "OpenAI", gemini: "Gemini", deepgram: "Deepgram", elevenlabs: "ElevenLabs" };

export function isLiveEngine(e: unknown): e is LiveEngine {
  return e === "openai" || e === "gemini" || e === "deepgram" || e === "elevenlabs";
}

/** What Mercury mints (POST /api/mobile/voice/dictation). */
export interface DictationToken {
  engine: LiveEngine;
  token: string;
  model?: string;
  url?: string;
  language?: string;
}

/** Where to connect and how to sign in (subprotocols stand in for headers). */
export interface Plan {
  engine: LiveEngine;
  url: string;
  protocols: string[];
  model: string;
}

/** Query values are codes and model names: anything else is dropped. */
export function safe(v: string): string {
  return v.replace(/[^A-Za-z0-9\-_.:]/g, "");
}

function opt(v: string | undefined): string | undefined {
  const t = v?.trim();
  if (!t || t === "auto") return undefined;
  return safe(t) || undefined;
}

/** A Gemini token ("auth_tokens/…") in a URL: only the characters they're made of. */
function geminiSecret(v: string): string {
  return v.replace(/[^A-Za-z0-9\-_./]/g, "");
}

export function plan(t: DictationToken): Plan {
  const secret = t.token.trim();
  if (!secret) throw new Error("no dictation token: ask Mercury for one first");
  const url = t.url?.trim() || undefined;
  const language = opt(t.language);
  switch (t.engine) {
    case "openai":
      return { engine: "openai", url: url ?? OPENAI_URL, protocols: ["realtime", `openai-insecure-api-key.${secret}`], model: opt(t.model) ?? OPENAI_MODEL };
    case "gemini": {
      const base = url ?? GEMINI_CONSTRAINED_URL;
      return { engine: "gemini", url: `${base}${base.includes("?") ? "&" : "?"}access_token=${geminiSecret(secret)}`, protocols: [], model: opt(t.model) ?? GEMINI_MODEL };
    }
    case "deepgram": {
      const model = opt(t.model) ?? DEEPGRAM_MODEL;
      const lang = language ?? "multi";
      return {
        engine: "deepgram",
        url: url ?? `wss://api.deepgram.com/v1/listen?model=${model}&language=${lang}&encoding=linear16&sample_rate=${CALL_RATE}&channels=1&interim_results=true&smart_format=true&punctuate=true&endpointing=300`,
        // A temporary token (POST /v1/auth/grant) is a Bearer JWT.
        protocols: ["bearer", secret],
        model,
      };
    }
    case "elevenlabs": {
      const model = opt(t.model) ?? ELEVENLABS_MODEL;
      let u = url ?? `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${model}&audio_format=pcm_${CALL_RATE}&commit_strategy=vad&vad_silence_threshold_secs=0.8`;
      if (language) u += `&language_code=${language}`;
      u += `&token=${safe(secret)}`;
      return { engine: "elevenlabs", url: u, protocols: [], model };
    }
    default:
      throw new Error(`"${String((t as { engine: unknown }).engine)}" can't do live dictation (use openai, gemini, deepgram or elevenlabs)`);
  }
}

/** Errors can quote the URL, which carries a token: never pass one on. */
export function redact(e: string): string {
  const i = [e.indexOf("access_token="), e.indexOf("token="), e.indexOf("key=")].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  return i === undefined ? e : `${e.slice(0, i)}…`;
}

/** The Gemini Live session for dictation (also what Mercury locks the minted token to). */
export function geminiSetup(model: string): Record<string, unknown> {
  return {
    model: `models/${model}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    inputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  };
}

export const GEMINI_ACTIVITY_START = JSON.stringify({ realtimeInput: { activityStart: {} } });

// ── text handling per engine (pure, tested) ──────────────────────────────

/** OpenAI items in the order they started: finals go out strictly in order. */
export class Items {
  list: { id: string; text: string; done: boolean }[] = [];

  delta(id: string, delta: string): DictationEvent[] {
    const i = this.list.find((x) => x.id === id);
    if (i && i.done) return [];
    if (i) i.text += delta;
    else this.list.push({ id, text: delta, done: false });
    return [{ type: "partial", text: this.partial() }];
  }

  /** An item is final: `text` (or, when transcription failed, what streamed so far). */
  done(id: string, text: string | null): DictationEvent[] {
    const i = this.list.find((x) => x.id === id);
    if (i) { if (text !== null) i.text = text; i.done = true; }
    else this.list.push({ id, text: text ?? "", done: true });
    const out: DictationEvent[] = [];
    while (this.list[0]?.done) {
      const t = this.list.shift()!.text.trim();
      if (t) out.push({ type: "final", text: t });
    }
    if (out.length) out.push({ type: "partial", text: this.partial() });
    return out;
  }

  partial(): string {
    return this.list.map((i) => i.text.trim()).filter(Boolean).join(" ");
  }

  pending(): boolean {
    return this.list.length > 0;
  }

  /** Whatever never completed, as final text (the stream is ending). */
  flush(): DictationEvent[] {
    const t = this.partial();
    this.list = [];
    return t ? [{ type: "final", text: t }] : [];
  }
}

export class State {
  items = new Items();
  /** OpenAI live model: speech heard since the last commit, and quiet after it. */
  heard = false;
  quietMs = 0;
  /** Deepgram/ElevenLabs/Gemini: the not-yet-final text (finalised if the stream ends first). */
  interim = "";
  /** OpenAI: the final commit was sent and not yet acknowledged. */
  awaitingCommit = false;
  /** The stream is finishing and the engine has nothing left to send. */
  drained = false;
  /** Gemini: transcript text came with the last message. */
  gotText = false;
  /** A fatal error from the engine, in plain words. */
  fatal: string | null = null;
}

/** Gemini's transcript arrives in small pieces: finished sentences go out final once the next starts. */
export function geminiText(st: State, piece: string): DictationEvent[] {
  st.interim += piece;
  let cut = -1;
  const s = st.interim;
  for (let i = 0; i + 1 < s.length; i++) if (".!?。！？".includes(s[i]) && /\s/.test(s[i + 1])) cut = i + 1;
  const out: DictationEvent[] = [];
  if (cut >= 0) {
    const done = s.slice(0, cut).trim();
    st.interim = s.slice(cut);
    if (done) out.push({ type: "final", text: done });
  }
  out.push({ type: "partial", text: st.interim.trim() });
  return out;
}

/** Plain words for OpenAI's fatal codes. */
export function explainOpenAI(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("insufficient_quota") || r.includes("billing")) return "your OpenAI account is out of credit";
  if (r.includes("invalid_api_key") || r.includes("unauthorized") || r.includes("401")) return "OpenAI rejected the key";
  if (r.includes("session_expired")) return "the OpenAI session expired";
  return `OpenAI: ${reason}`;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const at = (v: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), v);

export function onMessage(engine: LiveEngine, v: Json, st: State): DictationEvent[] {
  switch (engine) {
    case "openai": {
      switch (str(v.type)) {
        case "conversation.item.input_audio_transcription.delta": return st.items.delta(str(v.item_id), str(v.delta));
        case "conversation.item.input_audio_transcription.completed": return st.items.done(str(v.item_id), str(v.transcript));
        case "input_audio_buffer.committed": st.awaitingCommit = false; return [];
        case "conversation.item.input_audio_transcription.failed": return st.items.done(str(v.item_id), null);
        case "error": {
          const code = str(at(v, "error", "code"));
          const msg = str(at(v, "error", "message"));
          // An empty commit (a pause with nothing new) is harmless.
          if (code === "input_audio_buffer_commit_empty") st.awaitingCommit = false;
          if (["invalid_api_key", "insufficient_quota", "model_not_found", "session_expired"].includes(code)) st.fatal = explainOpenAI(`${code} ${msg}`);
          return [];
        }
        default: return [];
      }
    }
    case "gemini": {
      const t = at(v, "serverContent", "inputTranscription", "text");
      if (typeof t === "string" && t) {
        st.gotText = true;
        return geminiText(st, t);
      }
      return [];
    }
    case "deepgram": {
      switch (str(v.type)) {
        case "Results": {
          const t = str(at(v, "channel", "alternatives", 0, "transcript")).trim();
          if (v.is_final === true) {
            st.interim = "";
            return t ? [{ type: "final", text: t }] : [{ type: "partial", text: "" }];
          }
          if (t !== st.interim) { st.interim = t; return [{ type: "partial", text: t }]; }
          return [];
        }
        case "Metadata": st.drained = true; return [];
        case "Error": st.fatal = `Deepgram: ${str(v.description)}`; return [];
        default: return [];
      }
    }
    case "elevenlabs": {
      const kind = str(v.message_type);
      switch (kind) {
        case "partial_transcript": {
          const t = str(v.text).trim();
          if (t === st.interim) return [];
          st.interim = t;
          return [{ type: "partial", text: t }];
        }
        case "committed_transcript": {
          st.interim = "";
          st.drained = true;
          const t = str(v.text).trim();
          return t ? [{ type: "final", text: t }] : [{ type: "partial", text: "" }];
        }
        case "session_started": case "committed_transcript_with_timestamps": case "warning": return [];
        // Nothing to transcribe: not fatal.
        case "insufficient_audio_activity": case "commit_throttled": st.drained = true; return [];
        default: st.fatal = `ElevenLabs: ${str(v.error) || str(v.message) || kind}`; return [];
      }
    }
  }
}

/** The OpenAI live model's commit timer: true when a pause after speech should end the segment. */
export function shouldCommit(st: State, frame: Int16Array): boolean {
  const ms = Math.floor((frame.length * 1000) / CALL_RATE);
  let loud = false;
  for (let i = 0; i < frame.length; i++) if (Math.abs(frame[i]) > SPEECH_PEAK) { loud = true; break; }
  if (loud) { st.heard = true; st.quietMs = 0; return false; }
  st.quietMs += ms;
  if (st.heard && st.quietMs >= COMMIT_AFTER_QUIET_MS) { st.heard = false; return true; }
  return false;
}

// ── PCM helpers shared with the encoders ────────────────────────────────

/** PCM16 little-endian bytes. */
export function pcmBytes(frame: Int16Array): Uint8Array {
  const out = new Uint8Array(frame.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frame.length; i++) view.setInt16(i * 2, frame[i], true);
  return out;
}

export function b64(frame: Int16Array): string {
  const bytes = pcmBytes(frame);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Linear resampling (dictation.rs `resample`): 16 kHz → OpenAI's 24 kHz. */
export function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (!input.length || from === to) return input;
  const outLen = Math.max(1, Math.floor((input.length * to) / from));
  const step = from / to;
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, input.length - 1)];
    const b = input[Math.min(idx + 1, input.length - 1)];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac)));
  }
  return out;
}

/** One frame of audio, as the engine wants it. */
export function audioMessage(engine: LiveEngine, frame: Int16Array): string | Uint8Array {
  switch (engine) {
    case "openai": return JSON.stringify({ type: "input_audio_buffer.append", audio: b64(resample(frame, CALL_RATE, 24_000)) });
    case "gemini": return JSON.stringify({ realtimeInput: { audio: { data: b64(frame), mimeType: "audio/pcm;rate=16000" } } });
    case "deepgram": return pcmBytes(frame);
    case "elevenlabs": return JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(frame), commit: false, sample_rate: CALL_RATE });
  }
}

export const OPENAI_COMMIT = JSON.stringify({ type: "input_audio_buffer.commit" });
export const DEEPGRAM_KEEPALIVE = JSON.stringify({ type: "KeepAlive" });

/** What to send on finish so the last words become final. */
export function finishMessages(engine: LiveEngine, st: State): (string | Uint8Array)[] {
  switch (engine) {
    case "openai": return st.heard || st.items.pending() ? [OPENAI_COMMIT] : [];
    // Quiet, at once: never activityEnd or audioStreamEnd, which make the model reply.
    case "gemini": {
      const frame = new Int16Array(CALL_RATE / 10);
      return Array.from({ length: GEMINI_FLUSH_MS / 100 }, () => audioMessage("gemini", frame));
    }
    case "deepgram": return [JSON.stringify({ type: "Finalize" }), JSON.stringify({ type: "CloseStream" })];
    case "elevenlabs": return [JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: CALL_RATE })];
  }
}

/** Nothing more will come after finish (Gemini settles by time instead). */
export function finished(engine: LiveEngine, st: State): boolean {
  return engine === "openai" ? !st.items.pending() && !st.awaitingCommit : st.drained;
}
