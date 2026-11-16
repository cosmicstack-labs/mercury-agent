//! Live dictation: speech to text as it's spoken, nothing said back. The
//! phone's message box streams the owner's words while they talk.
//!
//! Engines (each with a short-lived token Mercury mints, or an API key):
//! - openai: a Realtime *transcription* session (`?intent=transcription`),
//!   `gpt-live-transcribe` by default. That model streams append-only deltas
//!   while audio arrives and has no server VAD, so this link commits a segment
//!   itself after a pause; other transcribe models use server VAD.
//! - deepgram: `/v1/listen` streaming with interim results (Nova-3).
//! - elevenlabs: Scribe realtime with VAD commits.
//!
//! Events: `Partial(text)` is the whole not-yet-final text so far (it replaces
//! the previous partial); `Final(text)` is a finished piece, in order (it
//! replaces the partial it came from). `Closed` ends the stream.
//!
//! Gemini Live isn't a dictation engine: it only transcribes input as a side
//! effect of a conversation in which the model also answers.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;

use crate::{CALL_RATE, Credential, b64, pcm_bytes, resample, ws};

pub const OPENAI_MODEL: &str = "gpt-live-transcribe";
pub const DEEPGRAM_MODEL: &str = "nova-3";
pub const ELEVENLABS_MODEL: &str = "scribe_v2_realtime";
pub const OPENAI_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";

/// OpenAI's live model has no server VAD: a segment is committed after this
/// much quiet following speech (the final text then arrives in ~0.5 s).
const COMMIT_AFTER_QUIET_MS: u32 = 900;
/// A frame louder than this (peak, PCM16) counts as speech for the commit timer.
const SPEECH_PEAK: u16 = 1200;
/// How long `Finish` waits for the last final text.
const FINISH_WAIT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DictationEvent {
    Partial(String),
    Final(String),
    /// The stream ended; the reason is in plain words ("stopped" after `Finish`).
    Closed(String),
}

#[derive(Debug)]
pub enum DictationCmd {
    /// Microphone audio, 16 kHz mono PCM16.
    Audio(Vec<i16>),
    /// Stop listening: the last words are finalised, then `Closed("stopped")`.
    Finish,
}

#[derive(Clone, Debug, Default)]
pub struct DictationConfig {
    /// "openai", "deepgram" or "elevenlabs".
    pub engine: String,
    pub model: Option<String>,
    /// A language code ("en", "hi"), or None to detect it.
    pub language: Option<String>,
}

pub struct Dictation {
    pub cmd: mpsc::UnboundedSender<DictationCmd>,
    pub events: mpsc::UnboundedReceiver<DictationEvent>,
}

pub fn label(engine: &str) -> &'static str {
    match engine {
        "openai" => "OpenAI",
        "deepgram" => "Deepgram",
        "elevenlabs" => "ElevenLabs",
        _ => "the speech service",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    OpenAi,
    Deepgram,
    ElevenLabs,
}

/// Where to connect and how to sign in.
#[derive(Debug, PartialEq)]
struct Plan {
    kind: Kind,
    url: String,
    headers: Vec<(&'static str, String)>,
    model: String,
    language: Option<String>,
    /// OpenAI with an API key: the session is configured on the socket.
    configure: bool,
}

/// Query values are codes and model names: anything else is dropped.
fn safe(v: &str) -> String {
    v.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.:".contains(*c)).collect()
}

fn opt(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "auto").map(safe).filter(|s| !s.is_empty())
}

fn plan(cfg: &DictationConfig, cred: &Credential) -> Result<Plan, String> {
    let secret = cred.secret.trim().to_string();
    if secret.is_empty() {
        return Err("no dictation token: ask Mercury for one first".into());
    }
    let url = cred.url.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string);
    let language = opt(&cfg.language);
    Ok(match cfg.engine.as_str() {
        "openai" => Plan {
            kind: Kind::OpenAi,
            url: url.unwrap_or_else(|| OPENAI_URL.into()),
            headers: vec![("authorization", format!("Bearer {secret}"))],
            model: opt(&cfg.model).unwrap_or_else(|| OPENAI_MODEL.into()),
            language,
            configure: !cred.ephemeral,
        },
        "deepgram" => {
            let model = opt(&cfg.model).unwrap_or_else(|| DEEPGRAM_MODEL.into());
            let lang = language.clone().unwrap_or_else(|| "multi".into());
            Plan {
                kind: Kind::Deepgram,
                url: url.unwrap_or_else(|| format!(
                    "wss://api.deepgram.com/v1/listen?model={model}&language={lang}&encoding=linear16&sample_rate={CALL_RATE}&channels=1&interim_results=true&smart_format=true&punctuate=true&endpointing=300"
                )),
                // A temporary token (POST /v1/auth/grant) is a Bearer JWT; an API key is `Token`.
                headers: vec![("authorization", if cred.ephemeral { format!("Bearer {secret}") } else { format!("Token {secret}") })],
                model,
                language,
                configure: false,
            }
        }
        "elevenlabs" => {
            let model = opt(&cfg.model).unwrap_or_else(|| ELEVENLABS_MODEL.into());
            let mut u = url.unwrap_or_else(|| format!(
                "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={model}&audio_format=pcm_{CALL_RATE}&commit_strategy=vad&vad_silence_threshold_secs=0.8"
            ));
            if let Some(l) = &language { u.push_str(&format!("&language_code={l}")); }
            // A single-use token goes in the URL; an API key in a header.
            let headers = if cred.ephemeral {
                u.push_str(&format!("&token={}", safe(&secret)));
                vec![]
            } else {
                vec![("xi-api-key", secret)]
            };
            Plan { kind: Kind::ElevenLabs, url: u, headers, model, language, configure: false }
        }
        other => return Err(format!("\"{other}\" can't do live dictation (use openai, deepgram or elevenlabs)")),
    })
}

/// The OpenAI transcription session (also what Mercury mints a client secret for).
pub fn openai_session(model: &str, language: Option<&str>) -> Value {
    let live = model.contains("live");
    let mut transcription = json!({ "model": model });
    if let Some(l) = language {
        // The live model takes language hints as a list.
        if live { transcription["languages"] = json!([l]); } else { transcription["language"] = json!(l); }
    }
    json!({
        "type": "transcription",
        "audio": { "input": {
            "format": { "type": "audio/pcm", "rate": 24_000 },
            "transcription": transcription,
            "turn_detection": if live { Value::Null } else { json!({ "type": "server_vad", "silence_duration_ms": 600 }) },
        } },
    })
}

// ── per-engine text handling (pure, tested) ───────────────────────────────

/// OpenAI items in the order they started: finals go out strictly in order,
/// even though completions can arrive out of order.
#[derive(Default, Debug)]
struct Items {
    list: Vec<(String, String, bool)>,
}

impl Items {
    fn delta(&mut self, id: &str, delta: &str) -> Vec<DictationEvent> {
        match self.list.iter_mut().find(|i| i.0 == id) {
            Some(i) if !i.2 => i.1.push_str(delta),
            Some(_) => return vec![],
            None => self.list.push((id.to_string(), delta.to_string(), false)),
        }
        vec![DictationEvent::Partial(self.partial())]
    }

    /// An item is final: `text` (or, when transcription failed, what streamed so far).
    fn done(&mut self, id: &str, text: Option<&str>) -> Vec<DictationEvent> {
        match self.list.iter_mut().find(|i| i.0 == id) {
            Some(i) => { if let Some(t) = text { i.1 = t.to_string(); } i.2 = true; }
            None => self.list.push((id.to_string(), text.unwrap_or("").to_string(), true)),
        }
        let mut out = Vec::new();
        while self.list.first().is_some_and(|i| i.2) {
            let (_, t, _) = self.list.remove(0);
            let t = t.trim().to_string();
            if !t.is_empty() { out.push(DictationEvent::Final(t)); }
        }
        if !out.is_empty() { out.push(DictationEvent::Partial(self.partial())); }
        out
    }

    fn partial(&self) -> String {
        self.list.iter().map(|i| i.1.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
    }

    fn pending(&self) -> bool {
        !self.list.is_empty()
    }

    /// Whatever never completed, as final text (the stream is ending).
    fn flush(&mut self) -> Vec<DictationEvent> {
        let t = self.partial();
        self.list.clear();
        if t.is_empty() { vec![] } else { vec![DictationEvent::Final(t)] }
    }
}

#[derive(Default, Debug)]
struct State {
    items: Items,
    /// OpenAI live model: speech heard since the last commit, and quiet after it.
    heard: bool,
    quiet_ms: u32,
    /// Deepgram: the last interim text (finalised if the stream ends first).
    interim: String,
    /// OpenAI: the final commit was sent and not yet acknowledged.
    awaiting_commit: bool,
    /// The stream is finishing and the engine has nothing left to send.
    drained: bool,
    /// A fatal error from the engine, in plain words.
    fatal: Option<String>,
}

fn on_message(kind: Kind, v: &Value, st: &mut State) -> Vec<DictationEvent> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    match kind {
        Kind::OpenAi => match s("type") {
            "conversation.item.input_audio_transcription.delta" => st.items.delta(s("item_id"), s("delta")),
            "conversation.item.input_audio_transcription.completed" => st.items.done(s("item_id"), Some(s("transcript"))),
            "input_audio_buffer.committed" => { st.awaiting_commit = false; vec![] }
            "conversation.item.input_audio_transcription.failed" => {
                crate::log(format!("dictation: transcription failed: {}", v.get("error").map(Value::to_string).unwrap_or_default()));
                st.items.done(s("item_id"), None)
            }
            "error" => {
                let e = v.get("error").cloned().unwrap_or(Value::Null);
                let msg = e.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                let code = e.get("code").and_then(Value::as_str).unwrap_or("");
                // An empty commit (a pause with nothing new) is harmless.
                if code == "input_audio_buffer_commit_empty" {
                    st.awaiting_commit = false;
                } else {
                    crate::log(format!("dictation: OpenAI error {code}: {msg}"));
                }
                if matches!(code, "invalid_api_key" | "insufficient_quota" | "model_not_found" | "session_expired") {
                    st.fatal = Some(crate::explain_close(&format!("{code} {msg}")));
                }
                vec![]
            }
            _ => vec![],
        },
        Kind::Deepgram => match s("type") {
            "Results" => {
                let t = v.pointer("/channel/alternatives/0/transcript").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if v.get("is_final").and_then(Value::as_bool) == Some(true) {
                    st.interim.clear();
                    if t.is_empty() { vec![DictationEvent::Partial(String::new())] } else { vec![DictationEvent::Final(t)] }
                } else if t != st.interim {
                    st.interim = t.clone();
                    vec![DictationEvent::Partial(t)]
                } else {
                    vec![]
                }
            }
            "Metadata" => { st.drained = true; vec![] }
            "Error" => { st.fatal = Some(format!("Deepgram: {}", s("description"))); vec![] }
            _ => vec![],
        },
        Kind::ElevenLabs => match s("message_type") {
            "partial_transcript" => {
                let t = s("text").trim().to_string();
                if t == st.interim { vec![] } else { st.interim = t.clone(); vec![DictationEvent::Partial(t)] }
            }
            "committed_transcript" => {
                st.interim.clear();
                st.drained = true;
                let t = s("text").trim().to_string();
                if t.is_empty() { vec![DictationEvent::Partial(String::new())] } else { vec![DictationEvent::Final(t)] }
            }
            "session_started" | "committed_transcript_with_timestamps" | "warning" => vec![],
            // insufficient_audio_activity / commit_throttled: nothing to transcribe, not fatal.
            "insufficient_audio_activity" | "commit_throttled" => { st.drained = true; vec![] }
            kind => {
                let e = v.get("error").and_then(Value::as_str).or_else(|| v.get("message").and_then(Value::as_str)).unwrap_or(kind);
                st.fatal = Some(format!("ElevenLabs: {e}"));
                vec![]
            }
        },
    }
}

/// The OpenAI live model's commit timer: true when a pause after speech should end the segment.
fn should_commit(st: &mut State, frame: &[i16]) -> bool {
    let ms = (frame.len() as u32 * 1000) / CALL_RATE;
    let loud = frame.iter().any(|s| s.unsigned_abs() > SPEECH_PEAK);
    if loud {
        st.heard = true;
        st.quiet_ms = 0;
        return false;
    }
    st.quiet_ms = st.quiet_ms.saturating_add(ms);
    if st.heard && st.quiet_ms >= COMMIT_AFTER_QUIET_MS {
        st.heard = false;
        return true;
    }
    false
}

fn audio_message(kind: Kind, frame: &[i16]) -> Message {
    match kind {
        Kind::OpenAi => Message::text(json!({ "type": "input_audio_buffer.append", "audio": b64(&resample(frame, CALL_RATE, 24_000)) }).to_string()),
        Kind::Deepgram => Message::binary(pcm_bytes(frame)),
        Kind::ElevenLabs => Message::text(json!({ "message_type": "input_audio_chunk", "audio_base_64": b64(frame), "commit": false, "sample_rate": CALL_RATE }).to_string()),
    }
}

fn finish_messages(kind: Kind, st: &State) -> Vec<Message> {
    match kind {
        Kind::OpenAi => if st.heard || st.items.pending() { vec![Message::text(json!({ "type": "input_audio_buffer.commit" }).to_string())] } else { vec![] },
        Kind::Deepgram => vec![
            Message::text(json!({ "type": "Finalize" }).to_string()),
            Message::text(json!({ "type": "CloseStream" }).to_string()),
        ],
        Kind::ElevenLabs => vec![Message::text(json!({ "message_type": "input_audio_chunk", "audio_base_64": "", "commit": true, "sample_rate": CALL_RATE }).to_string())],
    }
}

/// Nothing more will come after `Finish`.
fn finished(kind: Kind, st: &State) -> bool {
    match kind {
        Kind::OpenAi => !st.items.pending() && !st.awaiting_commit,
        Kind::Deepgram => st.drained,
        Kind::ElevenLabs => st.drained,
    }
}

/// Open a dictation stream. Returns once connected.
pub async fn open(cfg: &DictationConfig, cred: &Credential) -> Result<Dictation, String> {
    let p = plan(cfg, cred)?;
    let name = label(&cfg.engine);
    let mut sock = ws::connect(&p.url, &p.headers).await.map_err(|e| format!("couldn't reach {name}: {e}"))?;
    if p.configure {
        let update = json!({ "type": "session.update", "session": openai_session(&p.model, p.language.as_deref()) });
        sock.send(Message::text(update.to_string())).await.map_err(|e| e.to_string())?;
    }
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(p.kind, name, sock, cmd_rx, ev_tx));
    Ok(Dictation { cmd: cmd_tx, events: ev_rx })
}

async fn run(kind: Kind, name: &'static str, sock: ws::Socket, mut cmd: mpsc::UnboundedReceiver<DictationCmd>, ev: mpsc::UnboundedSender<DictationEvent>) {
    let (mut tx, mut rx) = sock.split();
    let mut st = State::default();
    let emit = |list: Vec<DictationEvent>| for e in list { let _ = ev.send(e); };
    let mut finishing: Option<tokio::time::Instant> = None;
    let mut keepalive = tokio::time::interval(Duration::from_secs(5));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let end = loop {
        let deadline = finishing.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            c = cmd.recv(), if finishing.is_none() => match c {
                Some(DictationCmd::Audio(frame)) => {
                    let commit = kind == Kind::OpenAi && should_commit(&mut st, &frame);
                    if tx.send(audio_message(kind, &frame)).await.is_err() { break format!("{name} disconnected"); }
                    if commit && tx.send(Message::text(json!({ "type": "input_audio_buffer.commit" }).to_string())).await.is_err() {
                        break format!("{name} disconnected");
                    }
                }
                None | Some(DictationCmd::Finish) => {
                    let msgs = finish_messages(kind, &st);
                    st.awaiting_commit = kind == Kind::OpenAi && !msgs.is_empty();
                    for m in msgs { let _ = tx.send(m).await; }
                    if kind == Kind::OpenAi && finished(kind, &st) { break "stopped".into(); }
                    finishing = Some(tokio::time::Instant::now() + FINISH_WAIT);
                }
            },
            m = rx.next() => {
                let Some(Ok(m)) = m else {
                    break if finishing.is_some() { "stopped".into() } else { format!("{name} disconnected") };
                };
                if m.is_close() {
                    let reason = m.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                    break if finishing.is_some() { "stopped".into() } else if reason.is_empty() { format!("{name} closed the connection") } else { format!("{name}: {reason}") };
                }
                let Some(text) = m.as_text() else { continue };
                let Ok(v) = serde_json::from_str::<Value>(text) else { continue };
                emit(on_message(kind, &v, &mut st));
                if let Some(f) = st.fatal.take() { break f; }
                if finishing.is_some() && finished(kind, &st) { break "stopped".into(); }
            }
            _ = keepalive.tick(), if kind == Kind::Deepgram && finishing.is_none() => {
                let _ = tx.send(Message::text(json!({ "type": "KeepAlive" }).to_string())).await;
            }
            _ = tokio::time::sleep_until(deadline), if finishing.is_some() => break "stopped".into(),
        }
    };
    // Words that never got a final still count.
    emit(st.items.flush());
    if !st.interim.is_empty() { emit(vec![DictationEvent::Final(std::mem::take(&mut st.interim))]); }
    let _ = tx.close().await;
    let _ = ev.send(DictationEvent::Closed(end));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cred(secret: &str, ephemeral: bool) -> Credential {
        Credential { secret: secret.into(), ephemeral, url: None }
    }

    fn cfg(engine: &str) -> DictationConfig {
        DictationConfig { engine: engine.into(), model: None, language: None }
    }

    #[test]
    fn plans_per_engine() {
        let p = plan(&cfg("openai"), &cred("ek_1", true)).unwrap();
        assert_eq!((p.url.as_str(), p.model.as_str(), p.configure), (OPENAI_URL, OPENAI_MODEL, false));
        assert_eq!(p.headers, vec![("authorization", "Bearer ek_1".to_string())]);
        assert!(plan(&cfg("openai"), &cred("sk", false)).unwrap().configure);

        let p = plan(&DictationConfig { language: Some("en".into()), ..cfg("deepgram") }, &cred("jwt", true)).unwrap();
        assert!(p.url.starts_with("wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=16000"), "{}", p.url);
        assert!(p.url.contains("interim_results=true"));
        assert_eq!(p.headers, vec![("authorization", "Bearer jwt".to_string())]);
        assert_eq!(plan(&cfg("deepgram"), &cred("key", false)).unwrap().headers, vec![("authorization", "Token key".to_string())]);
        assert!(plan(&cfg("deepgram"), &cred("k", true)).unwrap().url.contains("language=multi"));

        let p = plan(&cfg("elevenlabs"), &cred("sutkn_1", true)).unwrap();
        assert!(p.url.contains("model_id=scribe_v2_realtime") && p.url.contains("commit_strategy=vad") && p.url.ends_with("&token=sutkn_1"), "{}", p.url);
        assert!(p.headers.is_empty());
        assert_eq!(plan(&cfg("elevenlabs"), &cred("xi", false)).unwrap().headers, vec![("xi-api-key", "xi".to_string())]);

        assert!(plan(&cfg("gemini"), &cred("t", true)).is_err());
        assert!(plan(&cfg("openai"), &cred(" ", true)).is_err());
        // Odd characters never reach a URL.
        let p = plan(&DictationConfig { language: Some("en&x=1".into()), ..cfg("deepgram") }, &cred("k", true)).unwrap();
        assert!(p.url.contains("language=enx1&"), "{}", p.url);
    }

    #[test]
    fn openai_session_shapes() {
        let live = openai_session("gpt-live-transcribe", Some("en"));
        assert_eq!(live["type"], "transcription");
        assert_eq!(live["audio"]["input"]["turn_detection"], Value::Null);
        assert_eq!(live["audio"]["input"]["transcription"]["languages"], json!(["en"]));
        let older = openai_session("gpt-4o-transcribe", Some("en"));
        assert_eq!(older["audio"]["input"]["turn_detection"]["type"], "server_vad");
        assert_eq!(older["audio"]["input"]["transcription"]["language"], "en");
    }

    #[test]
    fn openai_partials_then_finals_in_order() {
        let mut st = State::default();
        let d = |st: &mut State, id: &str, t: &str| on_message(Kind::OpenAi, &json!({ "type": "conversation.item.input_audio_transcription.delta", "item_id": id, "delta": t }), st);
        let c = |st: &mut State, id: &str, t: &str| on_message(Kind::OpenAi, &json!({ "type": "conversation.item.input_audio_transcription.completed", "item_id": id, "transcript": t }), st);
        assert_eq!(d(&mut st, "a", " Remind"), vec![DictationEvent::Partial("Remind".into())]);
        assert_eq!(d(&mut st, "a", " me."), vec![DictationEvent::Partial("Remind me.".into())]);
        assert_eq!(d(&mut st, "b", " And"), vec![DictationEvent::Partial("Remind me. And".into())]);
        // The second item completes first: nothing final until the first does.
        assert_eq!(c(&mut st, "b", "And then."), vec![]);
        assert_eq!(c(&mut st, "a", "Remind me."), vec![
            DictationEvent::Final("Remind me.".into()), DictationEvent::Final("And then.".into()), DictationEvent::Partial(String::new()),
        ]);
        assert!(!st.items.pending());
        // A failed item keeps what streamed.
        d(&mut st, "c", " lost words");
        let failed = on_message(Kind::OpenAi, &json!({ "type": "conversation.item.input_audio_transcription.failed", "item_id": "c" }), &mut st);
        assert_eq!(failed[0], DictationEvent::Final("lost words".into()));
        // Unfinished text is finalised when the stream ends.
        d(&mut st, "d", " tail");
        assert_eq!(st.items.flush(), vec![DictationEvent::Final("tail".into())]);
    }

    #[test]
    fn openai_fatal_errors_end_the_stream() {
        let mut st = State::default();
        on_message(Kind::OpenAi, &json!({ "type": "error", "error": { "code": "input_audio_buffer_commit_empty", "message": "x" } }), &mut st);
        assert!(st.fatal.is_none());
        on_message(Kind::OpenAi, &json!({ "type": "error", "error": { "code": "insufficient_quota", "message": "no" } }), &mut st);
        assert!(st.fatal.unwrap().contains("out of credit"));
    }

    #[test]
    fn commits_after_a_pause_that_follows_speech() {
        let mut st = State::default();
        let quiet = vec![0i16; 960];
        let loud = vec![5000i16; 960];
        for _ in 0..30 { assert!(!should_commit(&mut st, &quiet)); }
        assert!(!should_commit(&mut st, &loud));
        let commits: Vec<bool> = (0..20).map(|_| should_commit(&mut st, &quiet)).collect();
        assert_eq!(commits.iter().filter(|c| **c).count(), 1, "one commit per pause");
        assert!(commits[14] && !commits[13], "after 900 ms: {commits:?}");
    }

    #[test]
    fn deepgram_interims_and_finals() {
        let mut st = State::default();
        let r = |st: &mut State, t: &str, fin: bool| on_message(Kind::Deepgram, &json!({ "type": "Results", "is_final": fin, "channel": { "alternatives": [{ "transcript": t }] } }), st);
        assert_eq!(r(&mut st, "book a", false), vec![DictationEvent::Partial("book a".into())]);
        assert_eq!(r(&mut st, "book a", false), vec![]);
        assert_eq!(r(&mut st, "Book a table.", true), vec![DictationEvent::Final("Book a table.".into())]);
        assert_eq!(r(&mut st, "", true), vec![DictationEvent::Partial(String::new())]);
        assert!(!st.drained);
        on_message(Kind::Deepgram, &json!({ "type": "Metadata" }), &mut st);
        assert!(st.drained);
        on_message(Kind::Deepgram, &json!({ "type": "Error", "description": "bad token" }), &mut st);
        assert_eq!(st.fatal.as_deref(), Some("Deepgram: bad token"));
    }

    #[test]
    fn elevenlabs_partials_and_commits() {
        let mut st = State::default();
        let m = |st: &mut State, kind: &str, t: &str| on_message(Kind::ElevenLabs, &json!({ "message_type": kind, "text": t }), st);
        assert_eq!(m(&mut st, "session_started", ""), vec![]);
        assert_eq!(m(&mut st, "partial_transcript", "hello th"), vec![DictationEvent::Partial("hello th".into())]);
        assert_eq!(m(&mut st, "committed_transcript", "Hello there."), vec![DictationEvent::Final("Hello there.".into())]);
        assert_eq!(m(&mut st, "committed_transcript_with_timestamps", "Hello there."), vec![]);
        on_message(Kind::ElevenLabs, &json!({ "message_type": "auth_error", "error": "invalid token" }), &mut st);
        assert_eq!(st.fatal.as_deref(), Some("ElevenLabs: invalid token"));
    }
}
