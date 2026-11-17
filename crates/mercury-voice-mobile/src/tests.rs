use super::*;

fn cfg(engine: &str) -> VoiceConfig {
    VoiceConfig {
        engine: engine.into(),
        token: "ek_x".into(),
        ephemeral: true,
        url: None,
        model: Some("m".into()),
        voice: Some("v".into()),
        instructions: "hi".into(),
        tools_json: r#"[{"type":"function","name":"ask_mercury","parameters":{"type":"object"}}]"#.into(),
    }
}

#[test]
fn engines_map_to_the_optimus_setting_keys() {
    assert_eq!(settings_for(&cfg("openai")).unwrap(), json!({ "voiceEngine": "openai", "phoneCall": true, "voiceModel": "m", "voice": "v" }));
    let mut g = cfg("gemini");
    g.model = Some("models/gemini-live".into());
    assert_eq!(settings_for(&g).unwrap(), json!({ "voiceEngine": "gemini", "phoneCall": true, "geminiModel": "gemini-live", "geminiVoice": "v" }));
    assert!(matches!(settings_for(&cfg("grok")), Err(VoiceError::Config { .. })));
}

#[test]
fn bad_configs_fail_at_once() {
    let mut c = cfg("openai");
    c.tools_json = "{".into();
    assert!(link_config(&c).is_err());
    c.tools_json = "{}".into();
    assert!(link_config(&c).is_err());
    let mut c = cfg("openai");
    c.token = " ".into();
    assert!(link_config(&c).is_err());
    let (lc, auth) = link_config(&cfg("openai")).unwrap();
    assert_eq!(lc.tools.as_array().unwrap().len(), 1);
    assert!(matches!(auth, Auth::Token(Credential { ephemeral: true, .. })));
}

#[test]
fn pcm_bytes_round_trip() {
    let s = vec![0i16, 1, -1, i16::MAX, i16::MIN];
    assert_eq!(mercury_voice::pcm_from_bytes(&mercury_voice::pcm_bytes(&s)), s);
}

struct Collect(std::sync::mpsc::Sender<VoiceEvent>);
impl VoiceListener for Collect {
    fn on_event(&self, event: VoiceEvent) {
        let _ = self.0.send(event);
    }
}

#[test]
fn a_failed_connect_closes_with_a_reason_and_never_blocks() {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut c = cfg("openai");
    c.url = Some("ws://127.0.0.1:9/realtime".into()); // nothing listens on the discard port
    let t = std::time::Instant::now();
    let call = VoiceCall::start(c, Arc::new(Collect(tx))).unwrap();
    assert!(t.elapsed() < Duration::from_millis(50), "start must return at once");
    call.push_audio(vec![0; 640]);
    let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(&e, VoiceEvent::Closed { reason } if reason.contains("couldn't reach the voice model")), "{e:?}");
}

#[test]
fn stop_while_connecting_says_stopped() {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut c = cfg("openai");
    c.url = Some("ws://10.255.255.1:81/realtime".into()); // unroutable: connect hangs
    let call = VoiceCall::start(c, Arc::new(Collect(tx))).unwrap();
    call.stop();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), VoiceEvent::Closed { reason: "stopped".into() });
}

/// Live smoke test against a real provider (tiny paid usage). Mint a session
/// with Mercury's POST /api/mobile/voice/session, save the JSON, then:
///
///   SMOKE_SESSION=session.json SMOKE_PCM=question.s16le cargo test --release smoke -- --ignored --nocapture
///
/// SMOKE_PCM: 16 kHz mono s16le speech (`say -o q.aiff "…" && ffmpeg -i q.aiff -ar 16000 -ac 1 -f s16le q.pcm`).
#[test]
#[ignore]
fn smoke_live_call() {
    use std::time::Instant;
    let session: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("SMOKE_SESSION").expect("SMOKE_SESSION")).unwrap()).unwrap();
    let speech = std::fs::read(std::env::var("SMOKE_PCM").expect("SMOKE_PCM")).unwrap();
    let s = |k: &str| session.get(k).and_then(Value::as_str).map(str::to_string);
    let config = VoiceConfig {
        engine: s("engine").unwrap(),
        token: s("token").unwrap(),
        ephemeral: true,
        url: s("url"),
        model: s("model"),
        voice: s("voice"),
        instructions: s("instructions").unwrap_or_default(),
        tools_json: session.get("tools").map(Value::to_string).unwrap_or_else(|| "[]".into()),
    };
    let engine = config.engine.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let started = Instant::now();
    let call = VoiceCall::start(config, Arc::new(Collect(tx))).unwrap();
    let wait = |rx: &std::sync::mpsc::Receiver<VoiceEvent>, ms: u64| rx.recv_timeout(Duration::from_millis(ms)).ok();
    match wait(&rx, 20_000) {
        Some(VoiceEvent::Connected) => println!("[{engine}] connected in {} ms", started.elapsed().as_millis()),
        other => panic!("[{engine}] didn't connect: {other:?}"),
    }
    // Speak in real time, 40 ms frames, then keep the mic open with silence.
    let frame = 640 * 2;
    let mut chunks = speech.chunks(frame).map(<[u8]>::to_vec).collect::<Vec<_>>();
    let speech_frames = chunks.len();
    chunks.extend(std::iter::repeat_n(vec![0u8; frame], 25 * 30));
    let mut spoke_at: Option<Instant> = None;
    let mut first_audio: Option<Duration> = None;
    let (mut audio_bytes, mut tool_done, mut answered) = (0usize, false, false);
    let mut transcript = Vec::new();
    for (i, c) in chunks.into_iter().enumerate() {
        call.push_audio(c);
        if i + 1 == speech_frames { spoke_at = Some(Instant::now()); }
        let tick = Instant::now() + Duration::from_millis(40);
        while let Some(e) = wait(&rx, tick.saturating_duration_since(Instant::now()).as_millis() as u64) {
            match e {
                VoiceEvent::Audio { pcm16 } => {
                    audio_bytes += pcm16.len();
                    if first_audio.is_none() { first_audio = spoke_at.map(|t| t.elapsed()); }
                    if tool_done { answered = true; }
                }
                VoiceEvent::ToolCall { id, name, args_json } => {
                    println!("[{engine}] tool call {name} {args_json}");
                    call.tool_result(id, "It's 9:41 PM in Tokyo.".into());
                    tool_done = true;
                }
                VoiceEvent::UserText { text } => transcript.push(format!("user: {text}")),
                VoiceEvent::AssistantText { text } => transcript.push(format!("voice: {text}")),
                VoiceEvent::Closed { reason } => panic!("[{engine}] closed: {reason}"),
                _ => {}
            }
        }
        if first_audio.is_some() && (answered || (!tool_done && audio_bytes > 32_000 * 3)) && spoke_at.map(|t| t.elapsed() > Duration::from_secs(8)).unwrap_or(false) { break; }
    }
    call.stop();
    for line in &transcript { println!("[{engine}] {line}"); }
    let tta = first_audio.expect("no audio came back");
    println!("[{engine}] time to first audio after speech ended: {} ms; {:.1} s of audio back; tool round trip answered: {answered}", tta.as_millis(), audio_bytes as f64 / 32_000.0);
}
