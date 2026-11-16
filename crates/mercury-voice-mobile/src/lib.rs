//! Mercury's voice engine for the mobile apps (iOS now, Android later).
//!
//! A thin UniFFI layer over `mercury-voice`, the same links Optimus runs on
//! the desktop: start a call with a short-lived token Mercury minted
//! (`POST /api/mobile/voice/session`), push microphone audio, and get the
//! model's audio and events back through a listener. Like a desktop `Link`,
//! it only moves audio and events: deciding what to do with a tool call
//! (ask_mercury, end_conversation…) stays in the app, which answers with
//! `tool_result`.
//!
//! Threads: the engine runs on its own small tokio runtime. No method blocks
//! the caller; the listener is called from an engine thread (hop to the main
//! thread yourself for UI).
//!
//! Audio both ways is 16 kHz mono PCM16, little-endian bytes.
//!
//! `Dictation` (dictation.rs) is the other session: live speech to text for
//! the message box, with a token from `POST /api/mobile/voice/dictation`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mercury_voice::{Auth, CALL_RATE, Credential, LinkCmd, LinkConfig, LinkEvent};
use serde_json::{Value, json};
use tokio::sync::mpsc;

uniffi::setup_scaffolding!();

/// Live dictation for the message box (speech to text only).
pub mod dictation;

/// Sample rate of all audio in and out: 16 kHz mono PCM16.
#[uniffi::export]
pub fn voice_sample_rate() -> u32 {
    CALL_RATE
}

/// How to start a call. Everything comes from Mercury's
/// `POST /api/mobile/voice/session` answer.
#[derive(uniffi::Record, Clone, Debug)]
pub struct VoiceConfig {
    /// "openai" (OpenAI Realtime) or "gemini" (Gemini Live).
    pub engine: String,
    /// The short-lived token (or, for testing, an API key).
    pub token: String,
    /// True for a minted token; false for an API key.
    #[uniffi(default = true)]
    pub ephemeral: bool,
    /// The WebSocket URL Mercury returned, if any.
    #[uniffi(default = None)]
    pub url: Option<String>,
    #[uniffi(default = None)]
    pub model: Option<String>,
    #[uniffi(default = None)]
    pub voice: Option<String>,
    /// System instructions for the voice.
    #[uniffi(default = "")]
    pub instructions: String,
    /// Tool definitions, a JSON array of { type, name, description, parameters }.
    #[uniffi(default = "[]")]
    pub tools_json: String,
}

/// What the call reports, in order.
#[derive(uniffi::Enum, Clone, Debug, PartialEq)]
pub enum VoiceEvent {
    /// The session is open: audio can flow.
    Connected,
    /// Audio to play: 16 kHz mono PCM16, little-endian.
    Audio { pcm16: Vec<u8> },
    /// The user started talking: stop playback now (barge-in).
    SpeechStarted,
    /// A finished utterance from the user.
    UserText { text: String },
    /// What the voice said (for the transcript).
    AssistantText { text: String },
    /// The voice wants a tool; answer with `tool_result(id, output)`.
    ToolCall { id: String, name: String, args_json: String },
    ResponseStarted,
    ResponseDone,
    /// Peak levels, 0…1, about 12 a second while anyone is audible.
    Levels { mic: f32, voice: f32 },
    /// The call ended; the reason is in plain words. Nothing follows it.
    Closed { reason: String },
}

#[derive(uniffi::Error, Debug, Clone, PartialEq)]
pub enum VoiceError {
    /// The configuration can't start a call (unknown engine, bad tools JSON, no token).
    Config { reason: String },
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VoiceError::Config { reason } => f.write_str(reason),
        }
    }
}

impl std::error::Error for VoiceError {}

/// Receives a call's events (implemented in Swift / Kotlin).
#[uniffi::export(with_foreign)]
pub trait VoiceListener: Send + Sync {
    fn on_event(&self, event: VoiceEvent);
}

enum Ctl {
    Mic(Vec<i16>),
    Link(LinkCmd),
    Interrupt,
    Stop,
}

/// One live voice call.
#[derive(uniffi::Object)]
pub struct VoiceCall {
    tx: Mutex<Option<mpsc::UnboundedSender<Ctl>>>,
    muted: Arc<AtomicBool>,
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("mercury-voice")
            .enable_all()
            .build()
            .expect("mercury-voice runtime")
    })
}

/// The mercury-voice settings for this engine (the same keys Optimus reads).
fn settings_for(cfg: &VoiceConfig) -> Result<Value, VoiceError> {
    let opt = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let mut s = json!({ "voiceEngine": cfg.engine });
    match cfg.engine.as_str() {
        "openai" => {
            if let Some(m) = opt(&cfg.model) { s["voiceModel"] = json!(m); }
            if let Some(v) = opt(&cfg.voice) { s["voice"] = json!(v); }
        }
        "gemini" => {
            if let Some(m) = opt(&cfg.model) { s["geminiModel"] = json!(m.trim_start_matches("models/")); }
            if let Some(v) = opt(&cfg.voice) { s["geminiVoice"] = json!(v); }
        }
        other => return Err(VoiceError::Config { reason: format!("unknown voice engine \"{other}\" (use openai or gemini)") }),
    }
    Ok(s)
}

fn link_config(cfg: &VoiceConfig) -> Result<(LinkConfig, Auth), VoiceError> {
    if cfg.token.trim().is_empty() {
        return Err(VoiceError::Config { reason: "no voice token: ask Mercury for a session first".into() });
    }
    let tools: Value = if cfg.tools_json.trim().is_empty() {
        json!([])
    } else {
        serde_json::from_str(&cfg.tools_json).map_err(|e| VoiceError::Config { reason: format!("tools_json isn't valid JSON: {e}") })?
    };
    if !tools.is_array() {
        return Err(VoiceError::Config { reason: "tools_json must be a JSON array".into() });
    }
    let settings = settings_for(cfg)?;
    let auth = Auth::Token(Credential { secret: cfg.token.trim().to_string(), ephemeral: cfg.ephemeral, url: cfg.url.clone() });
    Ok((LinkConfig { instructions: cfg.instructions.clone(), tools, settings }, auth))
}

fn peak(samples: &[i16]) -> u32 {
    samples.iter().map(|s| s.unsigned_abs() as u32).max().unwrap_or(0)
}

#[uniffi::export]
impl VoiceCall {
    /// Start a call. Returns at once; `Connected` or `Closed` follows on the listener.
    #[uniffi::constructor]
    pub fn start(config: VoiceConfig, listener: Arc<dyn VoiceListener>) -> Result<Arc<Self>, VoiceError> {
        let (link_cfg, auth) = link_config(&config)?;
        let (tx, rx) = mpsc::unbounded_channel::<Ctl>();
        let muted = Arc::new(AtomicBool::new(false));
        let task = runtime().spawn(run(link_cfg, auth, rx, listener.clone(), muted.clone()));
        // A bug in the engine still ends the call with a reason, never in silence.
        runtime().spawn(async move {
            if task.await.is_err() {
                listener.on_event(VoiceEvent::Closed { reason: "the voice engine stopped unexpectedly".into() });
            }
        });
        Ok(Arc::new(Self { tx: Mutex::new(Some(tx)), muted }))
    }

    /// Microphone audio: 16 kHz mono PCM16, little-endian (20–100 ms frames).
    pub fn push_audio(&self, pcm16: Vec<u8>) {
        self.send(Ctl::Mic(mercury_voice::pcm_from_bytes(&pcm16)));
    }

    /// Mute the microphone (silence is sent instead, so the session stays open).
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    /// Stop the current reply: its remaining audio is dropped (stop playback too).
    pub fn interrupt(&self) {
        self.send(Ctl::Interrupt);
    }

    /// The result of a `ToolCall`.
    pub fn tool_result(&self, id: String, output: String) {
        self.send(Ctl::Link(LinkCmd::ToolResult { id, output }));
    }

    /// Have the voice say this, in its own words.
    pub fn say(&self, text: String) {
        self.send(Ctl::Link(LinkCmd::Say(text)));
    }

    /// An instruction the voice responds to now (context, a status update, an approval question).
    pub fn instruct(&self, text: String) {
        self.send(Ctl::Link(LinkCmd::Instruct(text)));
    }

    /// End the call. `Closed { reason: "stopped" }` follows.
    pub fn stop(&self) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(Ctl::Stop);
        }
    }
}

impl VoiceCall {
    fn send(&self, c: Ctl) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(c);
        }
    }
}

impl Drop for VoiceCall {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn run(cfg: LinkConfig, auth: Auth, mut rx: mpsc::UnboundedReceiver<Ctl>, listener: Arc<dyn VoiceListener>, muted: Arc<AtomicBool>) {
    let emit = |e: VoiceEvent| listener.on_event(e);
    let opening = mercury_voice::open_with(cfg, auth);
    tokio::pin!(opening);
    // While connecting: a stop ends it, instructions wait for the session,
    // microphone audio is dropped (it would be stale).
    let mut waiting: Vec<LinkCmd> = Vec::new();
    let mut link = loop {
        tokio::select! {
            r = &mut opening => match r {
                Ok(l) => break l,
                Err(e) => { emit(VoiceEvent::Closed { reason: e }); return; }
            },
            c = rx.recv() => match c {
                None | Some(Ctl::Stop) => { emit(VoiceEvent::Closed { reason: "stopped".into() }); return; }
                Some(Ctl::Link(cmd)) => waiting.push(cmd),
                Some(Ctl::Mic(_)) | Some(Ctl::Interrupt) => {}
            },
        }
    };
    for cmd in waiting { link.send(cmd); }
    emit(VoiceEvent::Connected);

    let mut mic_peak: u32 = 0;
    let mut voice_peak: u32 = 0;
    let mut quiet = true;
    // After an interrupt, the rest of that reply's audio is dropped.
    let mut dropping = false;
    let mut levels = tokio::time::interval(Duration::from_millis(80));
    levels.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            c = rx.recv() => match c {
                None | Some(Ctl::Stop) => { emit(VoiceEvent::Closed { reason: "stopped".into() }); return; }
                Some(Ctl::Mic(mut frame)) => {
                    if muted.load(Ordering::Relaxed) { frame.iter_mut().for_each(|s| *s = 0); }
                    mic_peak = mic_peak.max(peak(&frame));
                    link.send(LinkCmd::Audio(frame));
                }
                Some(Ctl::Interrupt) => { dropping = true; link.send(LinkCmd::Cancel); }
                Some(Ctl::Link(cmd)) => link.send(cmd),
            },
            e = link.events.recv() => {
                let Some(e) = e else { emit(VoiceEvent::Closed { reason: "the voice model disconnected".into() }); return };
                let out = match e {
                    LinkEvent::Audio(pcm) => {
                        if dropping { continue; }
                        voice_peak = voice_peak.max(peak(&pcm));
                        VoiceEvent::Audio { pcm16: mercury_voice::pcm_bytes(&pcm) }
                    }
                    LinkEvent::SpeechStarted => { dropping = false; VoiceEvent::SpeechStarted }
                    LinkEvent::UserText(text) => VoiceEvent::UserText { text },
                    LinkEvent::AssistantText(text) => VoiceEvent::AssistantText { text },
                    LinkEvent::ToolCall { id, name, args } => VoiceEvent::ToolCall { id, name, args_json: args.to_string() },
                    LinkEvent::ResponseStarted => { dropping = false; VoiceEvent::ResponseStarted }
                    LinkEvent::ResponseDone => VoiceEvent::ResponseDone,
                    LinkEvent::Closed(reason) => { emit(VoiceEvent::Closed { reason }); return; }
                };
                emit(out);
            }
            _ = levels.tick() => {
                let mic = std::mem::take(&mut mic_peak);
                let voice = std::mem::take(&mut voice_peak);
                // Silence is reported once, then nothing until someone is audible again.
                let audible = mic > 300 || voice > 300;
                if audible || !quiet {
                    emit(VoiceEvent::Levels { mic: mic as f32 / 32768.0, voice: voice as f32 / 32768.0 });
                }
                quiet = !audible;
            }
        }
    }
}

#[cfg(test)]
mod tests;
