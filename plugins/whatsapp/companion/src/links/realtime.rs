//! Speech-to-speech models on OpenAI's Realtime protocol. One client, small
//! per-provider profiles: OpenAI (default), Azure OpenAI, xAI Grok, Alibaba
//! Qwen-Omni (older event names), ElevenLabs Realtime (session minted via a
//! client secret; experimental until ElevenLabs documents server use).

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;
use whatsapp_rust::futures::{SinkExt, StreamExt};

use super::{Brain, CALL_RATE, Link, LinkCmd, LinkConfig, LinkEvent, b64, env_key, pcm_from_bytes, resample, setting, unb64, ws};

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

async fn profile(s: &Value) -> Result<Profile, String> {
    let engine = super::engine(s);
    Ok(match engine.as_str() {
        "openai" => {
            let key = env_key("MERCURY_PROVIDER_OPENAI_API_KEY").ok_or("no OpenAI provider key")?;
            let base = env_key("MERCURY_PROVIDER_OPENAI_BASE_URL").unwrap_or_else(|| "https://api.openai.com/v1".into());
            let model = setting(s, "voiceModel", "gpt-realtime-2.1");
            Profile {
                url: format!("{}/realtime?model={model}", base_ws(&base)),
                headers: vec![("authorization", format!("Bearer {key}"))],
                model, dialect: Dialect::Ga, in_rate: 24_000, out_rate: 24_000,
                voice: setting(s, "voice", "marin"), transcribe: Some("gpt-4o-mini-transcribe".into()),
            }
        }
        "azure" => {
            let key = env_key("AZURE_OPENAI_API_KEY").ok_or("no Azure OpenAI key")?;
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
            let key = env_key("MERCURY_PROVIDER_GROK_API_KEY").ok_or("no Grok provider key")?;
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
            let key = env_key("DASHSCOPE_API_KEY").ok_or("no Qwen (DashScope) key")?;
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
            let key = env_key("ELEVENLABS_API_KEY").ok_or("no ElevenLabs key")?;
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

fn session(p: &Profile, cfg: &LinkConfig) -> Value {
    let tools: Vec<Value> = cfg.tools.as_array().cloned().unwrap_or_default();
    match p.dialect {
        Dialect::Ga => {
            let mut input = json!({
                "format": { "type": "audio/pcm", "rate": p.in_rate },
                "turn_detection": { "type": "server_vad", "interrupt_response": true, "create_response": true },
            });
            if let Some(t) = &p.transcribe { input["transcription"] = json!({ "model": t }); }
            json!({ "type": "session.update", "session": {
                "type": "realtime", "model": p.model, "instructions": cfg.instructions,
                "audio": { "input": input, "output": { "format": { "type": "audio/pcm", "rate": p.out_rate }, "voice": p.voice } },
                "tools": tools,
            } })
        }
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

pub async fn open(cfg: LinkConfig) -> Result<Link, String> {
    let p = profile(&cfg.settings).await?;
    let sock = ws::connect(&p.url, &p.headers).await.map_err(|e| format!("couldn't reach the voice model: {e}"))?;
    let (mut tx, mut rx) = sock.split();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<LinkCmd>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<LinkEvent>();

    tx.send(Message::text(session(&p, &cfg).to_string())).await.map_err(|e| e.to_string())?;

    let (in_rate, dialect) = (p.in_rate, p.dialect);
    let p2 = Profile { url: String::new(), headers: vec![], model: p.model.clone(), dialect: p.dialect, in_rate: p.in_rate, out_rate: p.out_rate, voice: p.voice.clone(), transcribe: None };
    tokio::spawn(async move {
        while let Some(c) = cmd_rx.recv().await {
            let msgs: Vec<Value> = match c {
                LinkCmd::Audio(frame) => vec![json!({ "type": "input_audio_buffer.append", "audio": b64(&resample(&frame, CALL_RATE, in_rate)) })],
                LinkCmd::Instruct(text) => instruct(&p2, &text),
                LinkCmd::Say(text) => instruct(&p2, &format!("[Say this to the caller, in your own natural voice] {text}")),
                LinkCmd::ToolResult { id, output } => vec![
                    json!({ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": id, "output": output } }),
                    json!({ "type": "response.create" }),
                ],
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
                let _ = ev_tx.send(LinkEvent::Closed(crate::voice::explain_close(&reason)));
                return;
            }
            let Some(t) = m.as_text() else { continue };
            let Ok(v) = serde_json::from_str::<Value>(t) else { continue };
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
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
