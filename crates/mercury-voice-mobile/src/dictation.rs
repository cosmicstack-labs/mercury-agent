//! Live dictation for the phone's message box: the owner talks and the words
//! stream in as they speak. Mercury mints the token
//! (`POST /api/mobile/voice/dictation`); the engine is
//! `mercury_voice::dictation` (OpenAI Realtime transcription, Gemini Live
//! transcription, Deepgram or ElevenLabs Scribe). Nothing is said back.
//!
//! Audio pushed while it connects is kept (up to 15 s) and sent once the
//! stream is open, so the first words aren't lost to the connection.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mercury_voice::Credential;
use mercury_voice::dictation::{self as engine, DictationCmd};
use tokio::sync::mpsc;

use crate::{VoiceError, peak, runtime};

/// Most audio kept while connecting: 15 s of 60 ms frames.
const HELD_FRAMES: usize = 250;

/// How to start dictation: Mercury's `POST /api/mobile/voice/dictation` answer.
#[derive(uniffi::Record, Clone, Debug)]
pub struct DictationConfig {
    /// "openai", "gemini", "deepgram" or "elevenlabs".
    pub engine: String,
    /// The short-lived token (or, for testing, an API key).
    pub token: String,
    #[uniffi(default = true)]
    pub ephemeral: bool,
    /// The WebSocket URL Mercury returned, if any.
    #[uniffi(default = None)]
    pub url: Option<String>,
    #[uniffi(default = None)]
    pub model: Option<String>,
    /// A language code, or None to detect it.
    #[uniffi(default = None)]
    pub language: Option<String>,
}

/// What dictation reports, in order.
#[derive(uniffi::Enum, Clone, Debug, PartialEq)]
pub enum DictationEvent {
    /// Listening: the stream is open.
    Connected,
    /// All the not-yet-final text so far; it replaces the previous partial.
    Partial { text: String },
    /// A finished piece of text, in order; it replaces the partial it came from.
    Final { text: String },
    /// Microphone peak, 0…1, about 12 a second while audible.
    Levels { mic: f32 },
    /// Dictation ended ("stopped" after `stop`, "cancelled" after `cancel`, else why).
    /// Nothing follows it.
    Closed { reason: String },
}

/// Receives dictation events (implemented in Swift / Kotlin), on an engine thread.
#[uniffi::export(with_foreign)]
pub trait DictationListener: Send + Sync {
    fn on_event(&self, event: DictationEvent);
}

enum Ctl {
    Mic(Vec<i16>),
    Stop,
    Cancel,
}

/// One live dictation.
#[derive(uniffi::Object)]
pub struct Dictation {
    tx: Mutex<Option<mpsc::UnboundedSender<Ctl>>>,
}

fn parts(c: &DictationConfig) -> Result<(engine::DictationConfig, Credential), VoiceError> {
    if c.token.trim().is_empty() {
        return Err(VoiceError::Config { reason: "no dictation token: ask Mercury for one first".into() });
    }
    if !matches!(c.engine.as_str(), "openai" | "gemini" | "deepgram" | "elevenlabs") {
        return Err(VoiceError::Config { reason: format!("\"{}\" can't do live dictation (use openai, gemini, deepgram or elevenlabs)", c.engine) });
    }
    Ok((
        engine::DictationConfig { engine: c.engine.clone(), model: c.model.clone(), language: c.language.clone() },
        Credential { secret: c.token.trim().to_string(), ephemeral: c.ephemeral, url: c.url.clone() },
    ))
}

#[uniffi::export]
impl Dictation {
    /// Start listening. Returns at once; `Connected` or `Closed` follows on the listener.
    #[uniffi::constructor]
    pub fn start(config: DictationConfig, listener: Arc<dyn DictationListener>) -> Result<Arc<Self>, VoiceError> {
        let (cfg, cred) = parts(&config)?;
        let (tx, rx) = mpsc::unbounded_channel::<Ctl>();
        let task = runtime().spawn(run(cfg, cred, rx, listener.clone()));
        runtime().spawn(async move {
            if task.await.is_err() {
                listener.on_event(DictationEvent::Closed { reason: "the dictation engine stopped unexpectedly".into() });
            }
        });
        Ok(Arc::new(Self { tx: Mutex::new(Some(tx)) }))
    }

    /// Microphone audio: 16 kHz mono PCM16, little-endian (20–100 ms frames).
    pub fn push_audio(&self, pcm16: Vec<u8>) {
        self.send(Ctl::Mic(mercury_voice::pcm_from_bytes(&pcm16)));
    }

    /// Stop listening: the last words are finalised (a moment), then `Closed { "stopped" }`.
    pub fn stop(&self) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(Ctl::Stop);
        }
    }

    /// Stop now, dropping anything not yet final: `Closed { "cancelled" }` follows at once.
    pub fn cancel(&self) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(Ctl::Cancel);
        }
    }
}

impl Dictation {
    fn send(&self, c: Ctl) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(c);
        }
    }
}

impl Drop for Dictation {
    fn drop(&mut self) {
        self.cancel();
    }
}

async fn run(cfg: engine::DictationConfig, cred: Credential, mut rx: mpsc::UnboundedReceiver<Ctl>, listener: Arc<dyn DictationListener>) {
    let emit = |e: DictationEvent| listener.on_event(e);
    let opening = engine::open(&cfg, &cred);
    tokio::pin!(opening);
    let mut held: VecDeque<Vec<i16>> = VecDeque::new();
    let mut stop_after_open = false;
    let mut d = loop {
        tokio::select! {
            r = &mut opening => match r {
                Ok(d) => break d,
                Err(e) => { emit(DictationEvent::Closed { reason: e }); return; }
            },
            c = rx.recv(), if !stop_after_open => match c {
                Some(Ctl::Mic(f)) => { if held.len() == HELD_FRAMES { held.pop_front(); } held.push_back(f); }
                // Stopped while connecting with words already said: still transcribe them.
                Some(Ctl::Stop) if !held.is_empty() => stop_after_open = true,
                None | Some(Ctl::Stop) => { emit(DictationEvent::Closed { reason: "stopped".into() }); return; }
                Some(Ctl::Cancel) => { emit(DictationEvent::Closed { reason: "cancelled".into() }); return; }
            },
        }
    };
    emit(DictationEvent::Connected);
    for f in held.drain(..) { let _ = d.cmd.send(DictationCmd::Audio(f)); }
    if stop_after_open { let _ = d.cmd.send(DictationCmd::Finish); }

    let mut mic_peak: u32 = 0;
    let mut quiet = true;
    let mut controls_open = !stop_after_open;
    let mut levels = tokio::time::interval(Duration::from_millis(80));
    levels.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            c = rx.recv(), if controls_open => match c {
                Some(Ctl::Mic(f)) => { mic_peak = mic_peak.max(peak(&f)); let _ = d.cmd.send(DictationCmd::Audio(f)); }
                None | Some(Ctl::Stop) => { controls_open = false; let _ = d.cmd.send(DictationCmd::Finish); }
                Some(Ctl::Cancel) => { emit(DictationEvent::Closed { reason: "cancelled".into() }); return; }
            },
            e = d.events.recv() => {
                let out = match e {
                    None => DictationEvent::Closed { reason: "the dictation engine disconnected".into() },
                    Some(engine::DictationEvent::Partial(text)) => DictationEvent::Partial { text },
                    Some(engine::DictationEvent::Final(text)) => DictationEvent::Final { text },
                    Some(engine::DictationEvent::Closed(reason)) => DictationEvent::Closed { reason },
                };
                let closed = matches!(out, DictationEvent::Closed { .. });
                emit(out);
                if closed { return; }
            }
            _ = levels.tick(), if controls_open => {
                let mic = std::mem::take(&mut mic_peak);
                let audible = mic > 300;
                if audible || !quiet { emit(DictationEvent::Levels { mic: mic as f32 / 32768.0 }); }
                quiet = !audible;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    fn cfg(engine: &str) -> DictationConfig {
        DictationConfig { engine: engine.into(), token: "ek_x".into(), ephemeral: true, url: None, model: None, language: None }
    }

    struct Collect(std_mpsc::Sender<DictationEvent>);
    impl DictationListener for Collect {
        fn on_event(&self, event: DictationEvent) {
            let _ = self.0.send(event);
        }
    }

    #[test]
    fn bad_configs_fail_at_once() {
        let mut c = cfg("openai");
        c.token = "  ".into();
        assert!(parts(&c).is_err());
        assert!(parts(&cfg("grok")).is_err());
        for e in ["openai", "gemini", "deepgram", "elevenlabs"] {
            let (d, cred) = parts(&cfg(e)).unwrap();
            assert_eq!(d.engine, e);
            assert!(cred.ephemeral);
        }
    }

    #[test]
    fn a_failed_connect_closes_with_a_reason() {
        let (tx, rx) = std_mpsc::channel();
        let mut c = cfg("deepgram");
        c.url = Some("ws://127.0.0.1:9/listen".into());
        let t = std::time::Instant::now();
        let d = Dictation::start(c, Arc::new(Collect(tx))).unwrap();
        assert!(t.elapsed() < Duration::from_millis(50), "start must return at once");
        d.push_audio(vec![0; 1920]);
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(&e, DictationEvent::Closed { reason } if reason.contains("couldn't reach Deepgram")), "{e:?}");
    }

    #[test]
    fn cancel_and_stop_while_connecting() {
        let (tx, rx) = std_mpsc::channel();
        let mut c = cfg("openai");
        c.url = Some("ws://10.255.255.1:81/realtime".into()); // unroutable: connect hangs
        let d = Dictation::start(c.clone(), Arc::new(Collect(tx))).unwrap();
        d.cancel();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), DictationEvent::Closed { reason: "cancelled".into() });

        let (tx, rx) = std_mpsc::channel();
        let d = Dictation::start(c, Arc::new(Collect(tx))).unwrap();
        d.stop();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), DictationEvent::Closed { reason: "stopped".into() });
    }

    /// Live smoke test against a real provider (tiny paid usage). Mint a token with
    /// Mercury's POST /api/mobile/voice/dictation, save the JSON, then:
    ///
    ///   SMOKE_DICTATION=dictation.json SMOKE_PCM=speech.s16le cargo test --release smoke_live_dictation -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_live_dictation() {
        use serde_json::Value;
        use std::time::Instant;
        let session: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("SMOKE_DICTATION").expect("SMOKE_DICTATION")).unwrap()).unwrap();
        let speech = std::fs::read(std::env::var("SMOKE_PCM").expect("SMOKE_PCM")).unwrap();
        let s = |k: &str| session.get(k).and_then(Value::as_str).map(str::to_string);
        let config = DictationConfig {
            engine: s("engine").unwrap(), token: s("token").unwrap(), ephemeral: session.get("ephemeral").and_then(Value::as_bool).unwrap_or(true),
            url: s("url"), model: s("model"), language: s("language"),
        };
        let engine = config.engine.clone();
        let (tx, rx) = std_mpsc::channel();
        let tapped = Instant::now();
        let d = Dictation::start(config, Arc::new(Collect(tx))).unwrap();
        // Talk from the moment of the tap, in real time (60 ms frames), then 1.5 s of quiet.
        let frame = 960 * 2;
        let mut chunks = speech.chunks(frame).map(<[u8]>::to_vec).collect::<Vec<_>>();
        let speech_frames = chunks.len();
        chunks.extend(std::iter::repeat_n(vec![0u8; frame], 25));
        let (mut connected, mut first_partial, mut first_final) = (None, None, None);
        let mut finals = Vec::new();
        let mut partials = 0;
        let mut spoke_at = None;
        let mut handle = |e: DictationEvent, finals: &mut Vec<String>| match e {
            DictationEvent::Connected => connected = Some(tapped.elapsed()),
            DictationEvent::Partial { text } => {
                if !text.is_empty() { partials += 1; if first_partial.is_none() { first_partial = Some(tapped.elapsed()); println!("[{engine}] first partial {:>5} ms: {text}", tapped.elapsed().as_millis()); } }
            }
            DictationEvent::Final { text } => { if first_final.is_none() { first_final = Some(tapped.elapsed()); } println!("[{engine}] final   {:>5} ms: {text}", tapped.elapsed().as_millis()); finals.push(text); }
            DictationEvent::Closed { reason } => println!("[{engine}] closed  {:>5} ms: {reason}", tapped.elapsed().as_millis()),
            DictationEvent::Levels { .. } => {}
        };
        for (i, c) in chunks.into_iter().enumerate() {
            d.push_audio(c);
            if i + 1 == speech_frames { spoke_at = Some(Instant::now()); }
            let tick = Instant::now() + Duration::from_millis(60);
            while let Ok(e) = rx.recv_timeout(tick.saturating_duration_since(Instant::now())) { handle(e, &mut finals); }
        }
        let stop_at = Instant::now();
        d.stop();
        while let Ok(e) = rx.recv_timeout(Duration::from_secs(8)) {
            let closed = matches!(e, DictationEvent::Closed { .. });
            handle(e, &mut finals);
            if closed { break; }
        }
        println!("[{engine}] connected after {:?}; first partial {:?} after the tap; {partials} partials; first final {:?}; closed {} ms after stop; speech ended {} ms before stop",
            connected, first_partial, first_final, stop_at.elapsed().as_millis(), spoke_at.map(|t| (stop_at - t).as_millis()).unwrap_or(0));
        println!("[{engine}] text: {}", finals.join(" "));
        assert!(!finals.is_empty(), "no final text");
    }
}
