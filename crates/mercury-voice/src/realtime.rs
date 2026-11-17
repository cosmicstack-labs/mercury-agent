//! Speech-to-speech models on OpenAI's Realtime protocol. One client, small
//! per-provider profiles: OpenAI (default), Azure OpenAI, xAI Grok, Alibaba
//! Qwen-Omni (older event names), ElevenLabs Realtime (session minted via a
//! client secret; experimental until ElevenLabs documents server use).

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;
use futures_util::{SinkExt, StreamExt};

use crate::{Auth, Brain, CALL_RATE, Link, LinkCmd, LinkConfig, LinkEvent, b64, env_key, pcm_from_bytes, resample, setting, unb64, ws};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    /// OpenAI GA session shape (OpenAI, Azure, ElevenLabs).
    Ga,
    /// GA events, but voice and turn detection at the top of the session (xAI).
    Grok,
    /// Older Realtime shape and event names, tools nested in "function" (Qwen).
    Beta,
}

struct Profile {
    url: String,
    headers: Vec<(&'static str, String)>,
    model: String,
    dialect: Dialect,
    in_rate: u32,
    out_rate: u32,
    voice: String,
    transcribe: Option<String>,
}

fn base_ws(http_base: &str) -> String {
    let b = http_base.trim_end_matches('/');
    if let Some(r) = b.strip_prefix("https://") { format!("wss://{r}") } else if let Some(r) = b.strip_prefix("http://") { format!("ws://{r}") } else { b.to_string() }
}

async fn profile(s: &Value, auth: &Auth) -> Result<Profile, String> {
    let engine = crate::engine(s);
    Ok(match engine.as_str() {
        "openai" => {
            let key = auth.key("MERCURY_PROVIDER_OPENAI_API_KEY", "no OpenAI provider key")?;
            let base = env_key("MERCURY_PROVIDER_OPENAI_BASE_URL").unwrap_or_else(|| "https://api.openai.com/v1".into());
            let model = setting(s, "voiceModel", "gpt-realtime-2.1");
            Profile {
                url: auth.url().map(str::to_string).unwrap_or_else(|| format!("{}/realtime?model={model}", base_ws(&base))),
                headers: vec![("authorization", format!("Bearer {key}"))],
                model, dialect: Dialect::Ga, in_rate: 24_000, out_rate: 24_000,
                voice: setting(s, "voice", "marin"), transcribe: Some("gpt-4o-mini-transcribe".into()),
            }
        }
        "azure" => {
            let key = auth.key("AZURE_OPENAI_API_KEY", "no Azure OpenAI key")?;
            let endpoint = setting(s, "azureEndpoint", "");
            let host = endpoint.trim_start_matches("https://").trim_start_matches("wss://").trim_end_matches('/').to_string();
            if host.is_empty() { return Err("set the Azure endpoint (e.g. myresource.openai.azure.com)".into()); }
            let model = setting(s, "azureDeployment", "gpt-realtime-2.1");
            Profile {
                url: format!("wss://{host}/openai/v1/realtime?model={model}"),
                headers: vec![("api-key", key)],
                model, dialect: Dialect::Ga, in_rate: 24_000, out_rate: 24_000,
                voice: setting(s, "voice", "marin"), transcribe: Some(setting(s, "azureTranscribeModel", "whisper-1")),
            }
        }
        "grok" => {
            let key = auth.key("MERCURY_PROVIDER_GROK_API_KEY", "no Grok provider key")?;
            let model = setting(s, "grokModel", "grok-voice-latest");
            Profile {
                url: format!("wss://api.x.ai/v1/realtime?model={model}"),
                headers: vec![("authorization", format!("Bearer {key}"))],
                // xAI takes phone-rate audio directly: no resampling either way.
                model, dialect: Dialect::Grok, in_rate: CALL_RATE, out_rate: CALL_RATE,
                voice: setting(s, "grokVoice", "eve"), transcribe: Some("grok-transcribe".into()),
            }
        }
        "qwen" => {
            let key = auth.key("DASHSCOPE_API_KEY", "no Qwen (DashScope) key")?;
            let endpoint = setting(s, "qwenEndpoint", "dashscope-intl.aliyuncs.com");
            let host = endpoint.trim_start_matches("https://").trim_start_matches("wss://").trim_end_matches('/').to_string();
            let model = setting(s, "qwenModel", "qwen3.8-omni-flash-realtime");
            Profile {
                url: format!("wss://{host}/api-ws/v1/realtime?model={model}"),
                headers: vec![("authorization", format!("Bearer {key}"))],
                model, dialect: Dialect::Beta, in_rate: CALL_RATE, out_rate: 24_000,
                voice: setting(s, "qwenVoice", "Tina"), transcribe: Some("qwen3-asr-flash-realtime".into()),
            }
        }
        "elevenlabs" => {
            let key = auth.key("ELEVENLABS_API_KEY", "no ElevenLabs key")?;
            let model = setting(s, "elevenlabsModel", "eleven_realtime_v1_mini");
            let voice = setting(s, "elevenlabsVoice", "brian");
            let secret = eleven_client_secret(&key, &model, &voice).await?;
            Profile {
                url: "wss://api.elevenlabs.io/v1/convai/realtime".into(),
                headers: vec![("authorization", format!("Bearer {secret}"))],
                model, dialect: Dialect::Ga, in_rate: 24_000, out_rate: 24_000, voice, transcribe: None,
            }
        }
        other => return Err(format!("{other} isn't a realtime voice engine")),
    })
}

/// ElevenLabs Realtime is reached with a short-lived client secret minted with the API key.
#[cfg(feature = "elevenlabs")]
async fn eleven_client_secret(key: &str, model: &str, voice: &str) -> Result<String, String> {
    let body = json!({
        "session": { "type": "realtime", "model": model, "audio": { "output": { "voice": voice } } },
        "expires_after": { "anchor": "created_at", "seconds": 600 },
    });
    let key = key.to_string();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut res = ureq::post("https://api.elevenlabs.io/v1/convai/realtime/client_secrets")
            .header("xi-api-key", &key)
            .header("content-type", "application/json")
            .send(body.to_string().as_bytes())
            .map_err(|e| format!("ElevenLabs: {e}"))?;
        let v: Value = serde_json::from_str(&res.body_mut().read_to_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        v.get("value").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "ElevenLabs didn't return a session secret".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds without the HTTP client (the mobile engine) can't mint ElevenLabs secrets.
#[cfg(not(feature = "elevenlabs"))]
async fn eleven_client_secret(_key: &str, _model: &str, _voice: &str) -> Result<String, String> {
    Err("ElevenLabs Realtime isn't available in this build".into())
}

/// How the GA session hears the caller. `Hearing::Default` is what every
/// desktop call (Optimus) uses; only a phone call opts into the rest.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hearing {
    /// Server VAD that interrupts and answers by itself, no noise reduction.
    Default,
    /// Plus OpenAI's near-field noise reduction (a phone held close).
    NearField,
    /// Plus semantic VAD with low eagerness and no automatic interruption:
    /// the phone decides whether a "speech started" while Mercury talks is
    /// the owner (and cancels the reply) or someone in the background.
    NearFieldSemantic,
}

/// The GA session's `audio` object.
fn ga_audio(p: &Profile, hearing: Hearing) -> Value {
    let turn_detection = match hearing {
        Hearing::NearFieldSemantic => json!({ "type": "semantic_vad", "eagerness": "low", "interrupt_response": false, "create_response": true }),
        _ => json!({ "type": "server_vad", "interrupt_response": true, "create_response": true }),
    };
    let mut input = json!({
        "format": { "type": "audio/pcm", "rate": p.in_rate },
        "turn_detection": turn_detection,
    });
    if hearing != Hearing::Default { input["noise_reduction"] = json!({ "type": "near_field" }); }
    if let Some(t) = &p.transcribe { input["transcription"] = json!({ "model": t }); }
    json!({ "input": input, "output": { "format": { "type": "audio/pcm", "rate": p.out_rate }, "voice": p.voice } })
}

fn session(p: &Profile, cfg: &LinkConfig) -> Value {
    let tools: Vec<Value> = cfg.tools.as_array().cloned().unwrap_or_default();
    match p.dialect {
        Dialect::Ga => json!({ "type": "session.update", "session": {
            "type": "realtime", "model": p.model, "instructions": cfg.instructions,
            "audio": ga_audio(p, Hearing::Default),
            "tools": tools,
        } }),
        Dialect::Grok => json!({ "type": "session.update", "session": {
            "instructions": cfg.instructions, "voice": p.voice,
            "turn_detection": { "type": "server_vad" },
            "audio": {
                "input": { "format": { "type": "audio/pcm", "rate": p.in_rate }, "transcription": { "model": p.transcribe } },
                "output": { "format": { "type": "audio/pcm", "rate": p.out_rate } },
            },
            "tools": tools,
        } }),
        Dialect::Beta => json!({ "type": "session.update", "session": {
            "modalities": ["text", "audio"], "voice": p.voice, "instructions": cfg.instructions,
            "input_audio_format": "pcm", "output_audio_format": "pcm",
            "turn_detection": { "type": "server_vad", "silence_duration_ms": 700 },
            "input_audio_transcription": { "model": p.transcribe },
            "tools": tools.iter().map(|t| json!({ "type": "function", "function": {
                "name": t.get("name"), "description": t.get("description"), "parameters": t.get("parameters") } })).collect::<Vec<_>>(),
        } }),
    }
}

/// Phone calls only (`phoneCall` in the settings, set by mercury-voice-mobile):
/// the hearing upgrades, each as its own session.update after the main one,
/// with the whole `audio` object (nested objects aren't merged). Each one adds
/// to the last, so if the provider rejects one (an error event, logged) the
/// session keeps the one before it: near-field noise reduction first, then
/// semantic VAD on top. The instructions and tools are never at risk.
fn phone_hearing(p: &Profile) -> Vec<Value> {
    if p.dialect != Dialect::Ga { return vec![]; }
    [Hearing::NearField, Hearing::NearFieldSemantic]
        .into_iter()
        .map(|h| json!({ "type": "session.update", "session": { "type": "realtime", "audio": ga_audio(p, h) } }))
        .collect()
}

/// Phone calls with semantic VAD don't let the server cut a reply off, so a
/// caller who spoke while Mercury talked (and the phone judged it background
/// speech) could be left unanswered: the server commits their turn but can't
/// start a reply over the one in progress. This remembers such a turn and,
/// once the reply ends and the turn has words, asks for the answer.
#[derive(Default, Debug)]
struct OwedReply {
    responding: bool,
    /// The phone cancelled the current reply (a barge-in it accepted).
    cancelled: bool,
    /// A caller turn committed during a reply: (item id, transcript has words?).
    owed: Option<(String, Option<bool>)>,
    /// The reply ended while the owed turn's transcript was still coming.
    reply_over: bool,
}

impl OwedReply {
    fn response_started(&mut self) { self.responding = true; self.cancelled = false; self.owed = None; self.reply_over = false; }
    fn cancel(&mut self) { if self.responding { self.cancelled = true; } }
    fn committed(&mut self, item: &str) {
        if self.responding && !self.cancelled && !item.is_empty() { self.owed = Some((item.to_string(), None)); self.reply_over = false; }
    }
    /// True: send response.create now.
    fn transcribed(&mut self, item: &str, words: bool) -> bool {
        match &mut self.owed {
            Some((id, heard)) if id == item => {
                *heard = Some(words);
                if self.reply_over { let go = words; self.owed = None; self.reply_over = false; go } else { false }
            }
            _ => false,
        }
    }
    /// True: send response.create now.
    fn response_done(&mut self) -> bool {
        self.responding = false;
        self.cancelled = false;
        match &self.owed {
            Some((_, Some(words))) => { let go = *words; self.owed = None; go }
            Some((_, None)) => { self.reply_over = true; false }
            None => false,
        }
    }
}

/// An instruction the model should respond to now (status update, approval, greeting).
fn instruct(p: &Profile, text: &str) -> Vec<Value> {
    match p.dialect {
        // Qwen has no user text items: steer the next response directly.
        Dialect::Beta => vec![json!({ "type": "response.create", "response": { "instructions": text } })],
        _ => vec![
            json!({ "type": "conversation.item.create", "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }),
            json!({ "type": "response.create" }),
        ],
    }
}

pub async fn open(cfg: LinkConfig, auth: Auth) -> Result<Link, String> {
    let p = profile(&cfg.settings, &auth).await?;
    let sock = ws::connect(&p.url, &p.headers).await.map_err(|e| format!("couldn't reach the voice model: {e}"))?;
    let (mut tx, mut rx) = sock.split();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<LinkCmd>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<LinkEvent>();

    tx.send(Message::text(session(&p, &cfg).to_string())).await.map_err(|e| e.to_string())?;
    // A phone call hears with near-field noise reduction and semantic VAD (desktop calls: unchanged).
    let phone = crate::phone_call(&cfg.settings) && p.dialect == Dialect::Ga;
    if phone {
        for m in phone_hearing(&p) { tx.send(Message::text(m.to_string())).await.map_err(|e| e.to_string())?; }
    }
    // Messages the reading side needs sent (a phone call's owed reply).
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let owed = std::sync::Arc::new(std::sync::Mutex::new(OwedReply::default()));
    let owed_tx = owed.clone();

    let (in_rate, dialect) = (p.in_rate, p.dialect);
    let p2 = Profile { url: String::new(), headers: vec![], model: p.model.clone(), dialect: p.dialect, in_rate: p.in_rate, out_rate: p.out_rate, voice: p.voice.clone(), transcribe: None };
    tokio::spawn(async move {
        loop {
            let c = tokio::select! {
                c = cmd_rx.recv() => match c { Some(c) => c, None => break },
                m = out_rx.recv() => {
                    let Some(m) = m else { continue };
                    if tx.send(Message::text(m.to_string())).await.is_err() { return; }
                    continue;
                }
            };
            let msgs: Vec<Value> = match c {
                LinkCmd::Audio(frame) => vec![json!({ "type": "input_audio_buffer.append", "audio": b64(&resample(&frame, CALL_RATE, in_rate)) })],
                LinkCmd::Instruct(text) => instruct(&p2, &text),
                LinkCmd::Say(text) => instruct(&p2, &format!("[Say this to the caller, in your own natural voice] {text}")),
                LinkCmd::ToolResult { id, output } => vec![
                    json!({ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": id, "output": output } }),
                    json!({ "type": "response.create" }),
                ],
                // A phone call's semantic VAD leaves interrupting to the phone: cancel the reply.
                LinkCmd::Cancel if phone => {
                    owed_tx.lock().unwrap().cancel();
                    vec![json!({ "type": "response.cancel" })]
                }
                // Server VAD already interrupts the response; nothing to send.
                LinkCmd::Cancel => vec![],
            };
            for m in msgs {
                if tx.send(Message::text(m.to_string())).await.is_err() { return; }
            }
        }
        let _ = tx.close().await;
    });

    let out_rate = p.out_rate;
    tokio::spawn(async move {
        while let Some(m) = rx.next().await {
            let Ok(m) = m else { break };
            if m.is_close() {
                let reason = m.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                let _ = ev_tx.send(LinkEvent::Closed(crate::explain_close(&reason)));
                return;
            }
            let Some(t) = m.as_text() else { continue };
            let Ok(v) = serde_json::from_str::<Value>(t) else { continue };
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            if phone {
                let mut o = owed.lock().unwrap();
                let ask = match s("type").as_str() {
                    "response.created" => { o.response_started(); false }
                    "response.done" | "response.cancelled" => o.response_done(),
                    "input_audio_buffer.committed" => { o.committed(&s("item_id")); false }
                    "conversation.item.input_audio_transcription.completed" => o.transcribed(&s("item_id"), !s("transcript").trim().is_empty()),
                    // No transcript to judge by: answer rather than leave the caller hanging.
                    "conversation.item.input_audio_transcription.failed" => o.transcribed(&s("item_id"), true),
                    _ => false,
                };
                if ask { let _ = out_tx.send(json!({ "type": "response.create" })); }
            }
            let e = match s("type").as_str() {
                "response.created" => Some(LinkEvent::ResponseStarted),
                "response.done" | "response.cancelled" => Some(LinkEvent::ResponseDone),
                "response.output_audio.delta" | "response.audio.delta" => {
                    let pcm = pcm_from_bytes(&unb64(&s("delta")));
                    Some(LinkEvent::Audio(resample(&pcm, out_rate, CALL_RATE)))
                }
                "input_audio_buffer.speech_started" => Some(LinkEvent::SpeechStarted),
                "conversation.item.input_audio_transcription.completed" => Some(LinkEvent::UserText(s("transcript").trim().to_string())),
                "response.output_audio_transcript.done" | "response.audio_transcript.done" => Some(LinkEvent::AssistantText(s("transcript").trim().to_string())),
                "response.function_call_arguments.done" => Some(LinkEvent::ToolCall {
                    id: s("call_id"),
                    name: s("name"),
                    args: serde_json::from_str(&s("arguments")).unwrap_or(json!({})),
                }),
                "error" => {
                    crate::log(format!("voice model error: {}", v.get("error").map(|e| e.to_string()).unwrap_or_default()));
                    None
                }
                _ => None,
            };
            if let Some(e) = e {
                if ev_tx.send(e).is_err() { break; }
            }
        }
        let _ = dialect;
        let _ = ev_tx.send(LinkEvent::Closed("the voice model disconnected".into()));
    });

    Ok(Link { brain: Brain::Voice, cmd: cmd_tx, events: ev_rx })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Credential;

    #[tokio::test]
    async fn a_minted_secret_replaces_the_env_key() {
        let auth = Auth::Token(Credential { secret: "ek_test".into(), ephemeral: true, url: Some("wss://api.openai.com/v1/realtime?model=m".into()) });
        let p = profile(&json!({ "voiceEngine": "openai", "voiceModel": "m", "voice": "cedar" }), &auth).await.unwrap();
        assert_eq!(p.url, "wss://api.openai.com/v1/realtime?model=m");
        assert_eq!(p.headers, vec![("authorization", "Bearer ek_test".to_string())]);
        assert_eq!(p.voice, "cedar");
        let no_url = Auth::Token(Credential { secret: "ek".into(), ephemeral: true, url: None });
        let p = profile(&json!({ "voiceEngine": "openai" }), &no_url).await.unwrap();
        assert!(p.url.ends_with("/realtime?model=gpt-realtime-2.1"), "{}", p.url);
    }

    fn openai_profile() -> Profile {
        Profile { url: String::new(), headers: vec![], model: "m".into(), dialect: Dialect::Ga, in_rate: 24_000, out_rate: 24_000, voice: "marin".into(), transcribe: Some("t".into()) }
    }

    #[test]
    fn desktop_session_is_unchanged() {
        let cfg = LinkConfig { instructions: "i".into(), tools: json!([]), settings: json!({}) };
        let s = session(&openai_profile(), &cfg);
        assert_eq!(s.pointer("/session/audio").unwrap(), &json!({
            "input": {
                "format": { "type": "audio/pcm", "rate": 24_000 },
                "turn_detection": { "type": "server_vad", "interrupt_response": true, "create_response": true },
                "transcription": { "model": "t" },
            },
            "output": { "format": { "type": "audio/pcm", "rate": 24_000 }, "voice": "marin" },
        }));
        assert!(!crate::phone_call(&cfg.settings));
    }

    #[test]
    fn phone_hearing_steps_up_one_update_at_a_time() {
        let ups = phone_hearing(&openai_profile());
        assert_eq!(ups.len(), 2);
        let first = &ups[0]["session"]["audio"]["input"];
        assert_eq!(first["noise_reduction"], json!({ "type": "near_field" }));
        assert_eq!(first["turn_detection"]["type"], "server_vad");
        let second = &ups[1]["session"]["audio"]["input"];
        assert_eq!(second["noise_reduction"], json!({ "type": "near_field" }));
        assert_eq!(second["turn_detection"], json!({ "type": "semantic_vad", "eagerness": "low", "interrupt_response": false, "create_response": true }));
        // Whole audio object each time: format, transcription and voice stay.
        for u in &ups {
            assert_eq!(u["session"]["type"], "realtime");
            assert_eq!(u["session"]["audio"]["input"]["transcription"]["model"], "t");
            assert_eq!(u["session"]["audio"]["output"]["voice"], "marin");
            assert!(u["session"].get("instructions").is_none() && u["session"].get("tools").is_none());
        }
        let mut grok = openai_profile();
        grok.dialect = Dialect::Grok;
        assert!(phone_hearing(&grok).is_empty());
    }

    #[test]
    fn a_turn_spoken_over_a_reply_is_answered_after_it() {
        // Committed during a reply, transcript in before the reply ends.
        let mut o = OwedReply::default();
        o.response_started();
        o.committed("item1");
        assert!(!o.transcribed("item1", true));
        assert!(o.response_done());
        // Transcript arrives after the reply ended.
        o.response_started();
        o.committed("item2");
        assert!(!o.response_done());
        assert!(o.transcribed("item2", true));
        // Background noise with no words: no reply.
        o.response_started();
        o.committed("item3");
        assert!(!o.response_done());
        assert!(!o.transcribed("item3", false));
        // The phone cancelled the reply (accepted barge-in): the server answers by itself.
        o.response_started();
        o.cancel();
        o.committed("item4");
        assert!(!o.transcribed("item4", true));
        assert!(!o.response_done());
        // A turn while no reply is playing: the server answers by itself.
        o.committed("item5");
        assert!(!o.transcribed("item5", true));
        // Another item's transcript doesn't count.
        o.response_started();
        o.committed("item6");
        assert!(!o.response_done());
        assert!(!o.transcribed("other", true));
        assert!(o.transcribed("item6", true));
    }

    #[test]
    fn close_reasons_in_plain_words() {
        assert!(crate::explain_close("insufficient_quota").contains("out of credit"));
        assert_eq!(crate::explain_close(""), "the voice model closed the session");
    }
}
