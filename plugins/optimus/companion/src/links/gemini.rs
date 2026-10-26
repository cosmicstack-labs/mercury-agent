//! Google Gemini Live: native 16 kHz input, 24 kHz output, its own protocol.
//! Connections last ~10 minutes, so the link resumes the session (handle from
//! sessionResumptionUpdate) on goAway or a drop, and the call carries on.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;
use futures_util::{SinkExt, StreamExt};

use super::{Brain, CALL_RATE, Link, LinkCmd, LinkConfig, LinkEvent, b64, env_key, pcm_from_bytes, resample, setting, unb64, ws};

const URL: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

fn setup(cfg: &LinkConfig, handle: Option<&str>) -> Value {
    let s = &cfg.settings;
    let decls: Vec<Value> = cfg.tools.as_array().cloned().unwrap_or_default().iter().map(|t| json!({
        "name": t.get("name"), "description": t.get("description"), "parameters": t.get("parameters"),
    })).collect();
    let mut setup = json!({
        "model": format!("models/{}", setting(s, "geminiModel", "gemini-3.8-live")),
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": setting(s, "geminiVoice", "Kore") } } },
        },
        "systemInstruction": { "parts": [{ "text": cfg.instructions }] },
        "tools": [{ "functionDeclarations": decls }],
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "realtimeInputConfig": {
            "automaticActivityDetection": { "disabled": false, "silenceDurationMs": 600 },
            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
        },
        "contextWindowCompression": { "slidingWindow": {} },
        "sessionResumption": {},
    });
    if let Some(h) = handle { setup["sessionResumption"] = json!({ "handle": h }); }
    json!({ "setup": setup })
}

pub async fn open(cfg: LinkConfig) -> Result<Link, String> {
    let key = env_key("GEMINI_API_KEY").ok_or("no Gemini API key")?;
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<LinkCmd>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<LinkEvent>();
    // Fail fast on a bad key or model: the first connection is made here.
    let mut sock = connect(&key, &cfg, None).await?;

    tokio::spawn(async move {
        let mut handle: Option<String> = None;
        let mut names: HashMap<String, String> = HashMap::new();
        let (mut user_text, mut model_text) = (String::new(), String::new());
        let mut responding = false;
        'conn: loop {
            let (mut tx, mut rx) = sock.split();
            loop {
                tokio::select! {
                    c = cmd_rx.recv() => {
                        let Some(c) = c else { let _ = tx.close().await; return };
                        let msg = match c {
                            LinkCmd::Audio(frame) => json!({ "realtimeInput": { "audio": { "data": b64(&frame), "mimeType": "audio/pcm;rate=16000" } } }),
                            LinkCmd::Instruct(text) => json!({ "clientContent": { "turns": [{ "role": "user", "parts": [{ "text": text }] }], "turnComplete": true } }),
                            LinkCmd::Say(text) => json!({ "clientContent": { "turns": [{ "role": "user", "parts": [{ "text": format!("[Say this to the caller, naturally] {text}") }] }], "turnComplete": true } }),
                            LinkCmd::ToolResult { id, output } => {
                                let name = names.remove(&id).unwrap_or_default();
                                json!({ "toolResponse": { "functionResponses": [{ "id": id, "name": name, "response": { "result": output } }] } })
                            }
                            LinkCmd::Cancel => continue,
                        };
                        if tx.send(Message::text(msg.to_string())).await.is_err() { break; }
                    }
                    m = rx.next() => {
                        let Some(Ok(m)) = m else { break };
                        if m.is_close() {
                            let reason = m.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                            if handle.is_none() {
                                let _ = ev_tx.send(LinkEvent::Closed(format!("Gemini closed the session{}", if reason.is_empty() { String::new() } else { format!(": {reason}") })));
                                return;
                            }
                            break;
                        }
                        let text = if let Some(t) = m.as_text() { t.to_string() } else { String::from_utf8_lossy(&m.as_payload().to_vec()).to_string() };
                        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                        if let Some(h) = v.pointer("/sessionResumptionUpdate/newHandle").and_then(Value::as_str) {
                            if v.pointer("/sessionResumptionUpdate/resumable").and_then(Value::as_bool) != Some(false) { handle = Some(h.to_string()); }
                        }
                        if v.get("goAway").is_some() { break; } // resume on a fresh connection
                        if let Some(calls) = v.pointer("/toolCall/functionCalls").and_then(Value::as_array) {
                            for c in calls {
                                let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                let name = c.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                                names.insert(id.clone(), name.clone());
                                let _ = ev_tx.send(LinkEvent::ToolCall { id, name, args: c.get("args").cloned().unwrap_or(json!({})) });
                            }
                        }
                        let Some(sc) = v.get("serverContent") else { continue };
                        if sc.get("interrupted").and_then(Value::as_bool) == Some(true) {
                            let _ = ev_tx.send(LinkEvent::SpeechStarted);
                        }
                        if let Some(t) = sc.pointer("/inputTranscription/text").and_then(Value::as_str) { user_text.push_str(t); }
                        if let Some(t) = sc.pointer("/outputTranscription/text").and_then(Value::as_str) { model_text.push_str(t); }
                        if let Some(parts) = sc.pointer("/modelTurn/parts").and_then(Value::as_array) {
                            for part in parts {
                                if let Some(d) = part.pointer("/inlineData/data").and_then(Value::as_str) {
                                    if !responding {
                                        responding = true;
                                        let _ = ev_tx.send(LinkEvent::ResponseStarted);
                                        if !user_text.trim().is_empty() { let _ = ev_tx.send(LinkEvent::UserText(std::mem::take(&mut user_text).trim().to_string())); }
                                    }
                                    let _ = ev_tx.send(LinkEvent::Audio(resample(&pcm_from_bytes(&unb64(d)), 24_000, CALL_RATE)));
                                }
                            }
                        }
                        if sc.get("turnComplete").and_then(Value::as_bool) == Some(true) {
                            if !user_text.trim().is_empty() { let _ = ev_tx.send(LinkEvent::UserText(std::mem::take(&mut user_text).trim().to_string())); }
                            if !model_text.trim().is_empty() { let _ = ev_tx.send(LinkEvent::AssistantText(std::mem::take(&mut model_text).trim().to_string())); }
                            responding = false;
                            let _ = ev_tx.send(LinkEvent::ResponseDone);
                        }
                    }
                }
            }
            // Connection ended without the call ending: resume where we left off.
            for attempt in 0..3u64 {
                tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
                match connect(&key, &cfg, handle.as_deref()).await {
                    Ok(s) => { sock = s; continue 'conn; }
                    Err(e) => crate::log(format!("gemini resume failed: {e}")),
                }
            }
            let _ = ev_tx.send(LinkEvent::Closed("lost the connection to Gemini".into()));
            return;
        }
    });

    Ok(Link { brain: Brain::Voice, cmd: cmd_tx, events: ev_rx })
}

async fn connect(key: &str, cfg: &LinkConfig, handle: Option<&str>) -> Result<ws::Socket, String> {
    let mut sock = ws::connect(&format!("{URL}?key={key}"), &[]).await.map_err(|e| format!("couldn't reach Gemini: {e}"))?;
    sock.send(Message::text(setup(cfg, handle).to_string())).await.map_err(|e| e.to_string())?;
    // Wait for setupComplete before streaming audio.
    let wait = async {
        while let Some(m) = sock.next().await {
            let m = m.map_err(|e| e.to_string())?;
            if m.is_close() {
                let reason = m.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                let model = setting(&cfg.settings, "geminiModel", "gemini-3.8-live");
                return Err(if reason.to_lowercase().contains("not found") || reason.to_lowercase().contains("not supported") {
                    format!("Gemini doesn't accept the model \"{model}\" for live voice ({reason}). Set the Gemini Live model to gemini-3.8-live (or gemini-3.1-flash-live-preview)")
                } else {
                    format!("Gemini refused the session (model {model}): {reason}")
                });
            }
            let text = if let Some(t) = m.as_text() { t.to_string() } else { String::from_utf8_lossy(&m.as_payload().to_vec()).to_string() };
            if text.contains("setupComplete") { return Ok(()); }
        }
        Err("Gemini closed during setup".to_string())
    };
    tokio::time::timeout(Duration::from_secs(15), wait).await.map_err(|_| "Gemini setup timed out".to_string())??;
    Ok(sock)
}
