//! Streaming text-to-speech for the pipeline: Cartesia, ElevenLabs, MiniMax,
//! Sarvam, Deepgram. One connection per utterance, so cancelling (barge-in)
//! is just dropping the task: nothing half-spoken can leak into the next reply.

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;
use whatsapp_rust::futures::{SinkExt, StreamExt};

use super::{env_key, pcm_from_bytes, script_language, setting, strip_wav, unb64, ws};

pub fn key_name(provider: &str) -> Option<&'static str> {
    match provider {
        "cartesia" => Some("CARTESIA_API_KEY"),
        "elevenlabs" => Some("ELEVENLABS_API_KEY"),
        "minimax" => Some("MINIMAX_API_KEY"),
        "sarvam" => Some("SARVAM_API_KEY"),
        "deepgram" => Some("DEEPGRAM_API_KEY"),
        _ => None,
    }
}

pub fn label(provider: &str) -> String {
    match provider {
        "cartesia" => "Cartesia",
        "elevenlabs" => "ElevenLabs",
        "minimax" => "MiniMax",
        "sarvam" => "Sarvam",
        "deepgram" => "Deepgram",
        other => other,
    }
    .to_string()
}

fn default_voice(provider: &str) -> &'static str {
    match provider {
        "cartesia" => "a0e99841-438c-4a64-b679-ae501e7d6091",
        "elevenlabs" => "JBFqnCBsd6RMkjVDRZzb",
        "minimax" => "English_expressive_narrator",
        "sarvam" => "shubh",
        "deepgram" => "aura-2-thalia-en",
        _ => "",
    }
}

/// Speak `text`: 16 kHz PCM16 chunks go to `out` as they arrive. Returns when done.
pub async fn speak(settings: &Value, text: &str, out: &mpsc::UnboundedSender<Vec<i16>>) -> Result<(), String> {
    let provider = setting(settings, "ttsProvider", "cartesia");
    let key = env_key(key_name(&provider).ok_or_else(|| format!("unknown voice provider {provider}"))?)
        .ok_or_else(|| format!("{} needs its API key", label(&provider)))?;
    let voice = setting(settings, "ttsVoice", default_voice(&provider));
    let lang = script_language(text);
    let fail = |e: String| format!("{}: {e}", label(&provider));

    match provider.as_str() {
        "cartesia" => {
            let mut sock = ws::connect("wss://api.cartesia.ai/tts/websocket", &[("x-api-key", key), ("cartesia-version", "2026-08-14".into())]).await.map_err(fail)?;
            let req = json!({
                "model_id": setting(settings, "ttsModel", "sonic-3.6"),
                "transcript": text,
                "voice": { "id": voice },
                "language": lang,
                "context_id": format!("u{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)),
                "output_format": { "container": "raw", "encoding": "pcm_s16le", "sample_rate": 16000 },
                "continue": false,
            });
            sock.send(Message::text(req.to_string())).await.map_err(|e| fail(e.to_string()))?;
            while let Some(m) = sock.next().await {
                let m = m.map_err(|e| fail(e.to_string()))?;
                let Some(t) = m.as_text() else { continue };
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                match v.get("type").and_then(Value::as_str) {
                    Some("chunk") => if let Some(d) = v.get("data").and_then(Value::as_str) { let _ = out.send(pcm_from_bytes(&unb64(d))); },
                    Some("done") => break,
                    Some("error") => return Err(fail(v.get("message").and_then(Value::as_str).unwrap_or("error").to_string())),
                    _ => {}
                }
            }
            let _ = sock.close().await;
        }
        "elevenlabs" => {
            let url = format!(
                "wss://api.elevenlabs.io/v1/text-to-speech/{voice}/stream-input?model_id={}&output_format=pcm_16000&inactivity_timeout=30",
                setting(settings, "ttsModel", "eleven_flash_v2_5")
            );
            let mut sock = ws::connect(&url, &[("xi-api-key", key)]).await.map_err(fail)?;
            for msg in [json!({ "text": " " }), json!({ "text": format!("{text} "), "flush": true }), json!({ "text": "" })] {
                sock.send(Message::text(msg.to_string())).await.map_err(|e| fail(e.to_string()))?;
            }
            while let Some(m) = sock.next().await {
                let m = m.map_err(|e| fail(e.to_string()))?;
                if m.is_close() { break; }
                let Some(t) = m.as_text() else { continue };
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                if let Some(a) = v.get("audio").and_then(Value::as_str) { let _ = out.send(pcm_from_bytes(&unb64(a))); }
                if v.get("isFinal").and_then(Value::as_bool) == Some(true) { break; }
                if let Some(e) = v.get("error").and_then(Value::as_str) { return Err(fail(e.to_string())); }
            }
        }
        "minimax" => {
            let mut sock = ws::connect("wss://api.minimax.io/ws/v1/t2a_v2", &[("authorization", format!("Bearer {key}"))]).await.map_err(fail)?;
            let boost = match lang { "hi" => "Hindi", _ => "auto" };
            let mut started = false;
            while let Some(m) = sock.next().await {
                let m = m.map_err(|e| fail(e.to_string()))?;
                if m.is_close() { break; }
                let Some(t) = m.as_text() else { continue };
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                match v.get("event").and_then(Value::as_str) {
                    Some("connected_success") => {
                        let start = json!({
                            "event": "task_start",
                            "model": setting(settings, "ttsModel", "speech-2.8-turbo"),
                            "language_boost": boost,
                            "voice_setting": { "voice_id": voice, "speed": 1, "vol": 1, "pitch": 0 },
                            "audio_setting": { "sample_rate": 16000, "format": "pcm", "channel": 1 },
                        });
                        sock.send(Message::text(start.to_string())).await.map_err(|e| fail(e.to_string()))?;
                    }
                    Some("task_started") if !started => {
                        started = true;
                        sock.send(Message::text(json!({ "event": "task_continue", "text": text }).to_string())).await.map_err(|e| fail(e.to_string()))?;
                        sock.send(Message::text(json!({ "event": "task_finish" }).to_string())).await.map_err(|e| fail(e.to_string()))?;
                    }
                    Some("task_failed") => return Err(fail(v.pointer("/base_resp/status_msg").and_then(Value::as_str).unwrap_or("failed").to_string())),
                    Some("task_finished") => break,
                    _ => {
                        if let Some(h) = v.pointer("/data/audio").and_then(Value::as_str) {
                            let _ = out.send(pcm_from_bytes(&hex_decode(h)));
                        }
                        if v.get("is_final").and_then(Value::as_bool) == Some(true) { break; }
                    }
                }
            }
        }
        "sarvam" => {
            let url = format!("wss://api.sarvam.ai/text-to-speech/ws?model={}&send_completion_event=true", setting(settings, "ttsModel", "bulbul:v3"));
            let mut sock = ws::connect(&url, &[("api-subscription-key", key)]).await.map_err(fail)?;
            let language_code = match lang { "hi" => "hi-IN", _ => "en-IN" };
            let msgs = [
                json!({ "type": "config", "data": { "model": setting(settings, "ttsModel", "bulbul:v3"), "language_code": language_code, "speaker": voice, "pace": 1.0, "speech_sample_rate": 16000, "output_audio_codec": "linear16" } }),
                json!({ "type": "text", "data": { "text": text } }),
                json!({ "type": "flush" }),
            ];
            for msg in msgs {
                sock.send(Message::text(msg.to_string())).await.map_err(|e| fail(e.to_string()))?;
            }
            while let Some(m) = sock.next().await {
                let m = m.map_err(|e| fail(e.to_string()))?;
                if m.is_close() { break; }
                let Some(t) = m.as_text() else { continue };
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                match v.get("type").and_then(Value::as_str) {
                    Some("audio") => if let Some(a) = v.pointer("/data/audio").and_then(Value::as_str) { let bytes = unb64(a); let _ = out.send(pcm_from_bytes(strip_wav(&bytes))); },
                    Some("event") if v.pointer("/data/event_type").and_then(Value::as_str) == Some("final") => break,
                    Some("error") => return Err(fail(v.pointer("/data/message").and_then(Value::as_str).unwrap_or("error").to_string())),
                    _ => {}
                }
            }
            let _ = sock.close().await;
        }
        "deepgram" => {
            let url = format!("wss://api.deepgram.com/v1/speak?model={voice}&encoding=linear16&sample_rate=16000");
            let mut sock = ws::connect(&url, &[("authorization", format!("Token {key}"))]).await.map_err(fail)?;
            sock.send(Message::text(json!({ "type": "Speak", "text": text }).to_string())).await.map_err(|e| fail(e.to_string()))?;
            sock.send(Message::text(json!({ "type": "Flush" }).to_string())).await.map_err(|e| fail(e.to_string()))?;
            while let Some(m) = sock.next().await {
                let m = m.map_err(|e| fail(e.to_string()))?;
                if m.is_close() { break; }
                if m.is_binary() {
                    let _ = out.send(pcm_from_bytes(&m.as_payload().to_vec()));
                    continue;
                }
                let Some(t) = m.as_text() else { continue };
                let v: Value = serde_json::from_str(t).unwrap_or_default();
                if v.get("type").and_then(Value::as_str) == Some("Flushed") { break; }
            }
            let _ = sock.send(Message::text(json!({ "type": "Close" }).to_string())).await;
        }
        other => return Err(format!("unknown voice provider {other}")),
    }
    Ok(())
}

fn hex_decode(h: &str) -> Vec<u8> {
    let b = h.as_bytes();
    (0..b.len() / 2)
        .filter_map(|i| u8::from_str_radix(std::str::from_utf8(&b[i * 2..i * 2 + 2]).ok()?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn hex() {
        assert_eq!(super::hex_decode("00ff10"), vec![0, 255, 16]);
    }
}
