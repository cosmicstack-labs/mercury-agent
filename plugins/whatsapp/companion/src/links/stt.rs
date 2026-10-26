//! Streaming speech-to-text for the pipeline: Deepgram, AssemblyAI,
//! ElevenLabs Scribe, Sarvam. Each turns caller audio (16 kHz PCM16) into
//! "speech started" and "finished utterance" events.

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_websockets::Message;
use whatsapp_rust::futures::{SinkExt, StreamExt};

use super::{b64, pcm_bytes, setting, env_key, ws};

pub enum SttEvent {
    SpeechStarted,
    Final(String),
    Closed(String),
}

pub fn key_name(provider: &str) -> Option<&'static str> {
    match provider {
        "deepgram" => Some("DEEPGRAM_API_KEY"),
        "assemblyai" => Some("ASSEMBLYAI_API_KEY"),
        "elevenlabs" => Some("ELEVENLABS_API_KEY"),
        "sarvam" => Some("SARVAM_API_KEY"),
        _ => None,
    }
}

pub fn label(provider: &str) -> String {
    match provider {
        "deepgram" => "Deepgram",
        "assemblyai" => "AssemblyAI",
        "elevenlabs" => "ElevenLabs",
        "sarvam" => "Sarvam",
        other => other,
    }
    .to_string()
}

/// Start listening. Audio goes in on the returned sender; events come out on `events`.
pub async fn start(settings: &Value, events: mpsc::UnboundedSender<SttEvent>) -> Result<mpsc::UnboundedSender<Vec<i16>>, String> {
    let provider = setting(settings, "sttProvider", "deepgram");
    let lang = setting(settings, "sttLanguage", "auto");
    let key = env_key(key_name(&provider).ok_or_else(|| format!("unknown speech-to-text provider {provider}"))?)
        .ok_or_else(|| format!("{} needs its API key", label(&provider)))?;

    let (url, headers): (String, Vec<(&str, String)>) = match provider.as_str() {
        "deepgram" => {
            // Nova-3: "multi" covers en/hi and others; Urdu needs language=ur on its own.
            let language = if lang == "auto" { "multi".to_string() } else { lang.clone() };
            (
                format!("wss://api.deepgram.com/v1/listen?model={}&encoding=linear16&sample_rate=16000&channels=1&language={language}&interim_results=true&endpointing=400&utterance_end_ms=1000&vad_events=true&smart_format=true", setting(settings, "sttModel", "nova-3")),
                vec![("authorization", format!("Token {key}"))],
            )
        }
        "assemblyai" => {
            let detect = if lang == "auto" { "&language_detection=true".to_string() } else { format!("&language_codes={lang}") };
            (
                format!("wss://streaming.assemblyai.com/v3/ws?speech_model={}&sample_rate=16000&encoding=pcm_s16le&min_turn_silence=500{detect}", setting(settings, "sttModel", "universal-3-6-pro")),
                vec![("authorization", key)],
            )
        }
        "elevenlabs" => {
            let language = if lang == "auto" { String::new() } else { format!("&language_code={lang}") };
            (
                format!("wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={}&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=0.6{language}", setting(settings, "sttModel", "scribe_v2_realtime")),
                vec![("xi-api-key", key)],
            )
        }
        "sarvam" => {
            let language = match lang.as_str() { "auto" => "unknown".to_string(), l if l.contains('-') => l.to_string(), l => format!("{l}-IN") };
            (
                format!("wss://api.sarvam.ai/speech-to-text/ws?model={}&language-code={language}&sample_rate=16000&input_audio_codec=pcm_s16le&vad_signals=true&high_vad_sensitivity=true&mode=transcribe", setting(settings, "sttModel", "saaras:v4")),
                vec![("api-subscription-key", key)],
            )
        }
        other => return Err(format!("unknown speech-to-text provider {other}")),
    };

    let sock = ws::connect(&url, &headers).await.map_err(|e| format!("couldn't reach {}: {e}", label(&provider)))?;
    let (mut tx, mut rx) = sock.split();
    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();

    let p = provider.clone();
    tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                frame = audio_rx.recv() => {
                    let Some(frame) = frame else { break };
                    let msg = match p.as_str() {
                        "elevenlabs" => Message::text(json!({ "message_type": "input_audio_chunk", "audio_base_64": b64(&frame), "commit": false, "sample_rate": 16000 }).to_string()),
                        "sarvam" => Message::text(json!({ "audio": { "data": b64(&frame), "sample_rate": "16000", "encoding": "audio/wav" } }).to_string()),
                        _ => Message::binary(pcm_bytes(&frame)),
                    };
                    if tx.send(msg).await.is_err() { break; }
                }
                _ = keepalive.tick() => {
                    if p == "deepgram" && tx.send(Message::text(json!({ "type": "KeepAlive" }).to_string())).await.is_err() { break; }
                }
            }
        }
        let close = match p.as_str() {
            "deepgram" => Some(json!({ "type": "CloseStream" })),
            "assemblyai" => Some(json!({ "type": "Terminate" })),
            _ => None,
        };
        if let Some(c) = close { let _ = tx.send(Message::text(c.to_string())).await; }
        let _ = tx.close().await;
    });

    tokio::spawn(async move {
        // Deepgram sends final segments; an utterance ends at speech_final / UtteranceEnd.
        let mut pending = String::new();
        let mut speaking = false;
        while let Some(msg) = rx.next().await {
            let Ok(msg) = msg else { break };
            if msg.is_close() {
                let reason = msg.as_close().map(|(_, r)| r.to_string()).unwrap_or_default();
                let _ = events.send(SttEvent::Closed(if reason.is_empty() { format!("{} closed the connection", label(&provider)) } else { format!("{}: {reason}", label(&provider)) }));
                return;
            }
            let Some(text) = msg.as_text() else { continue };
            let Ok(v) = serde_json::from_str::<Value>(text) else { continue };
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            match provider.as_str() {
                "deepgram" => match s("type").as_str() {
                    "SpeechStarted" => { let _ = events.send(SttEvent::SpeechStarted); }
                    "Results" => {
                        let t = v.pointer("/channel/alternatives/0/transcript").and_then(Value::as_str).unwrap_or("").trim().to_string();
                        if !t.is_empty() && !speaking { speaking = true; let _ = events.send(SttEvent::SpeechStarted); }
                        if v.get("is_final").and_then(Value::as_bool) == Some(true) && !t.is_empty() {
                            if !pending.is_empty() { pending.push(' '); }
                            pending.push_str(&t);
                        }
                        if v.get("speech_final").and_then(Value::as_bool) == Some(true) && !pending.is_empty() {
                            let _ = events.send(SttEvent::Final(std::mem::take(&mut pending)));
                            speaking = false;
                        }
                    }
                    "UtteranceEnd" => {
                        if !pending.is_empty() { let _ = events.send(SttEvent::Final(std::mem::take(&mut pending))); }
                        speaking = false;
                    }
                    "Error" => crate::log(format!("deepgram: {}", s("description"))),
                    _ => {}
                },
                "assemblyai" => match s("type").as_str() {
                    "SpeechStarted" => { let _ = events.send(SttEvent::SpeechStarted); }
                    "Turn" => {
                        let t = s("transcript");
                        if !t.trim().is_empty() && !speaking { speaking = true; let _ = events.send(SttEvent::SpeechStarted); }
                        if v.get("end_of_turn").and_then(Value::as_bool) == Some(true) {
                            let u = if s("utterance").trim().is_empty() { t } else { s("utterance") };
                            if !u.trim().is_empty() { let _ = events.send(SttEvent::Final(u.trim().to_string())); }
                            speaking = false;
                        }
                    }
                    "Termination" => break,
                    _ => {}
                },
                "elevenlabs" => match s("message_type").as_str() {
                    "partial_transcript" => {
                        if !s("text").trim().is_empty() && !speaking { speaking = true; let _ = events.send(SttEvent::SpeechStarted); }
                    }
                    "committed_transcript" | "committed_transcript_with_timestamps" => {
                        let t = s("text");
                        if !t.trim().is_empty() { let _ = events.send(SttEvent::Final(t.trim().to_string())); }
                        speaking = false;
                    }
                    "session_started" => {}
                    kind => if v.get("error").is_some() { crate::log(format!("elevenlabs stt {kind}: {}", s("error"))); },
                },
                "sarvam" => match s("type").as_str() {
                    "events" => {
                        if v.pointer("/data/signal_type").and_then(Value::as_str) == Some("START_SPEECH") { let _ = events.send(SttEvent::SpeechStarted); }
                    }
                    "data" => {
                        let t = v.pointer("/data/transcript").and_then(Value::as_str).unwrap_or("").trim().to_string();
                        if !t.is_empty() { let _ = events.send(SttEvent::Final(t)); }
                    }
                    "error" => crate::log(format!("sarvam stt: {}", v.pointer("/data/error").and_then(Value::as_str).unwrap_or(""))),
                    _ => {}
                },
                _ => {}
            }
        }
        let _ = events.send(SttEvent::Closed(format!("{} disconnected", label(&provider))));
    });

    Ok(audio_tx)
}
