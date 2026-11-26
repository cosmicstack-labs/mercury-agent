import {
  DEEPGRAM_KEEPALIVE, ENGINE_LABELS, FINISH_WAIT_MS, GEMINI_ACTIVITY_START, GEMINI_FINISH_WAIT_MS, GEMINI_SETTLE_MS, OPENAI_COMMIT,
  State, audioMessage, finishMessages, finished, geminiSetup, onMessage, plan, redact, shouldCommit,
  type DictationEvent, type DictationToken, type LiveEngine,
} from "./protocol";

/**
 * One live dictation over a WebSocket (dictation.rs `open` + `run`): audio in
 * (16 kHz mono PCM16 frames), partial and final text out. Audio pushed while
 * the socket connects is kept and sent once it's ready, so nothing said in the
 * first second is lost. Works in the webview and, with Node's WebSocket, in the
 * smoke test (scripts/smoke-desktop-live-dictation.ts).
 */

export type WebSocketLike = {
  binaryType: string;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
};
export type WebSocketCtor = new (url: string, protocols?: string[]) => WebSocketLike;

export interface LiveDictationOptions {
  WebSocket?: WebSocketCtor;
  /** Gemini: how long to wait for setupComplete. */
  setupTimeoutMs?: number;
}

/** 15 s of 60 ms frames kept while connecting. */
const MAX_HELD = 250;

export class LiveDictation {
  readonly engine: LiveEngine;
  readonly name: string;
  private ws: WebSocketLike;
  private st = new State();
  private ready = false;
  private held: Int16Array[] = [];
  private finishing = false;
  private done = false;
  private lastText = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(token: DictationToken, private readonly onEvent: (e: DictationEvent) => void, opts: LiveDictationOptions = {}) {
    const p = plan(token);
    this.engine = p.engine;
    this.name = ENGINE_LABELS[p.engine];
    const Ctor = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    try {
      this.ws = p.protocols.length ? new Ctor(p.url, p.protocols) : new Ctor(p.url);
    } catch (err) {
      throw new Error(`couldn't reach ${this.name}: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      if (this.engine === "gemini") {
        this.ws.send(JSON.stringify({ setup: geminiSetup(p.model) }));
        this.timers.push(setTimeout(() => { if (!this.ready) this.end("Gemini didn't start in time"); }, opts.setupTimeoutMs ?? 15_000) as unknown as ReturnType<typeof setInterval>);
      } else {
        this.becomeReady();
      }
    };
    this.ws.onmessage = (e) => this.message(e.data);
    this.ws.onerror = () => { /* onclose follows with the reason */ };
    this.ws.onclose = (e) => {
      if (this.finishing) return this.end("stopped");
      const reason = redact(e.reason ?? "");
      this.end(!this.ready && this.engine === "gemini" ? (reason ? `Gemini refused dictation: ${reason}` : `couldn't reach ${this.name}`) : reason ? `${this.name}: ${reason}` : `${this.name} disconnected`);
    };
  }

  /** 16 kHz mono PCM16 from the microphone. */
  pushAudio(frame: Int16Array): void {
    if (this.done || this.finishing) return;
    if (!this.ready) {
      if (this.held.length === MAX_HELD) this.held.shift();
      this.held.push(frame);
      return;
    }
    this.sendFrame(frame);
  }

  /** Stop listening: the last words are finalised, then `closed("stopped")`. */
  finish(): void {
    if (this.done || this.finishing) return;
    if (!this.ready) {
      // Still connecting: what was said so far is sent once it's open, then this finishes.
      this.finishAfterReady = true;
      return;
    }
    this.startFinish();
  }

  /** Throw it all away. */
  cancel(): void {
    if (this.done) return;
    this.held = [];
    this.end("cancelled", false);
  }

  private finishAfterReady = false;

  private becomeReady(): void {
    if (this.ready || this.done) return;
    this.ready = true;
    const early = this.held;
    this.held = [];
    for (const f of early) this.sendFrame(f);
    if (this.engine === "deepgram") this.timers.push(setInterval(() => { if (!this.finishing) this.send(DEEPGRAM_KEEPALIVE); }, 5000));
    if (this.finishAfterReady) this.startFinish();
  }

  private sendFrame(frame: Int16Array): void {
    const commit = this.engine === "openai" && shouldCommit(this.st, frame);
    this.send(audioMessage(this.engine, frame));
    if (commit) this.send(OPENAI_COMMIT);
  }

  private send(m: string | Uint8Array): void {
    if (this.ws.readyState !== 1) return;
    try { this.ws.send(m); } catch { /* closing */ }
  }

  private startFinish(): void {
    this.finishing = true;
    const msgs = finishMessages(this.engine, this.st);
    this.st.awaitingCommit = this.engine === "openai" && msgs.length > 0;
    for (const m of msgs) this.send(m);
    if (this.engine === "openai" && finished(this.engine, this.st)) return this.end("stopped");
    this.lastText = Date.now();
    this.deadline = setTimeout(() => this.end("stopped"), this.engine === "gemini" ? GEMINI_FINISH_WAIT_MS : FINISH_WAIT_MS);
    if (this.engine === "gemini") this.timers.push(setInterval(() => { if (Date.now() - this.lastText >= GEMINI_SETTLE_MS) this.end("stopped"); }, 200));
  }

  private message(data: unknown): void {
    if (this.done) return;
    let text: string;
    if (typeof data === "string") text = data;
    // Gemini sends its JSON in binary frames.
    else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as ArrayBuffer);
    else return;
    let v: Record<string, unknown>;
    try { v = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    if (this.engine === "gemini" && !this.ready) {
      if ("setupComplete" in v) {
        this.send(GEMINI_ACTIVITY_START);
        this.becomeReady();
      }
      return;
    }
    for (const e of onMessage(this.engine, v, this.st)) this.onEvent(e);
    if (this.st.gotText) { this.st.gotText = false; this.lastText = Date.now(); }
    if (this.st.fatal) return this.end(this.st.fatal);
    if (this.finishing && this.engine !== "gemini" && finished(this.engine, this.st)) this.end("stopped");
  }

  private end(reason: string, keep = true): void {
    if (this.done) return;
    this.done = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.deadline) clearTimeout(this.deadline);
    if (keep) {
      // Words that never got a final still count.
      for (const e of this.st.items.flush()) this.onEvent(e);
      const rest = this.st.interim.trim();
      this.st.interim = "";
      if (rest) this.onEvent({ type: "final", text: rest });
    }
    try { this.ws.close(1000); } catch { /* already closed */ }
    this.onEvent({ type: "closed", reason });
  }
}
