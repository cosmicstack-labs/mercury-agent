//! Voice links: one per kind of voice provider, all speaking the same small
//! language to the call bridge (voice.rs). The bridge owns everything about
//! the call itself (Mercury questions, approvals, progress updates, photos,
//! summaries); a link only moves audio and events.
//!
//! - realtime: speech-to-speech models on OpenAI's Realtime protocol
//!   (OpenAI, Azure OpenAI, xAI Grok, ElevenLabs Realtime, Qwen-Omni)
//! - gemini: Google Gemini Live
//! - pipeline: speech-to-text → the user's own Mercury model → text-to-speech
//!   (Deepgram / AssemblyAI / ElevenLabs Scribe / Sarvam, then Cartesia /
//!   ElevenLabs / MiniMax / Sarvam / Deepgram voices)

pub mod gemini;
pub mod pipeline;
pub mod realtime;
pub mod stt;
pub mod tts;
pub mod ws;

use serde_json::Value;
use tokio::sync::mpsc;

/// Phone-call audio rate: 16 kHz mono PCM16.
pub const CALL_RATE: u32 = 16_000;

#[derive(Debug)]
pub enum LinkEvent {
    /// Audio for the caller, 16 kHz mono PCM16.
    Audio(Vec<i16>),
    /// The caller started talking: stop playing and cancel speech (barge-in).
    SpeechStarted,
    /// A finished utterance from the caller.
    UserText(String),
    /// What the voice said (for the transcript).
    AssistantText(String),
    /// The voice model wants a tool (ask_mercury, answer_approval, end_call).
    ToolCall { id: String, name: String, args: Value },
    ResponseStarted,
    ResponseDone,
    /// The provider closed the session; the reason is already in plain words.
    Closed(String),
}

#[derive(Debug)]
pub enum LinkCmd {
    /// Caller audio, 16 kHz mono PCM16, 60 ms frames.
    Audio(Vec<i16>),
    /// An instruction for a model that reasons (status update, approval question).
    Instruct(String),
    /// Speak exactly this (pipeline voices; realtime models are asked to say it).
    Say(String),
    /// The result of a ToolCall.
    ToolResult { id: String, output: String },
    /// Stop speaking now (barge-in).
    Cancel,
}

/// Does this link's own model reason and call tools, or does Mercury think for every turn?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Brain {
    /// A speech-to-speech model: it chats and calls ask_mercury when it needs to.
    Voice,
    /// Every caller utterance is a Mercury turn; the link only listens and speaks.
    Mercury,
}

pub struct Link {
    pub brain: Brain,
    pub cmd: mpsc::UnboundedSender<LinkCmd>,
    pub events: mpsc::UnboundedReceiver<LinkEvent>,
}

impl Link {
    pub fn send(&self, c: LinkCmd) {
        let _ = self.cmd.send(c);
    }
}

/// Everything a link needs to start: provider choice and keys come from the
/// plugin settings and environment (keys are passed by Mercury, never typed here).
pub struct LinkConfig {
    pub instructions: String,
    pub tools: Value,
    pub settings: Value,
}

pub fn setting<'a>(settings: &'a Value, key: &str, default: &'a str) -> String {
    settings.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or(default).trim().to_string()
}

pub fn env_key(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|k| !k.trim().is_empty())
}

/// Which voice engine the owner picked, and whether its keys are present.
pub fn engine(settings: &Value) -> String {
    setting(settings, "voiceEngine", "openai")
}

/// Human-readable reason calls can't start with the current settings, if any.
pub fn not_ready(settings: &Value) -> Option<String> {
    let need = |name: &str, what: &str| if env_key(name).is_none() { Some(format!("voice calls with {what} need its API key: add it in /plugins whatsapp → 🎙 Voice calls")) } else { None };
    match engine(settings).as_str() {
        "openai" => if env_key("MERCURY_PROVIDER_OPENAI_API_KEY").is_none() { Some("voice calls need an OpenAI key (recommended): add it once in the dashboard (Providers) or with `mercury doctor`, or pick another voice in /plugins whatsapp → 🎙 Voice calls".into()) } else { None },
        "grok" => if env_key("MERCURY_PROVIDER_GROK_API_KEY").is_none() { Some("voice calls with Grok need a Grok provider: add your xAI key in the dashboard (Providers)".into()) } else { None },
        "azure" => need("AZURE_OPENAI_API_KEY", "Azure OpenAI").or_else(|| if setting(settings, "azureEndpoint", "").is_empty() { Some("set the Azure endpoint in /plugins whatsapp".into()) } else { None }),
        "elevenlabs" => need("ELEVENLABS_API_KEY", "ElevenLabs"),
        "qwen" => need("DASHSCOPE_API_KEY", "Qwen (Alibaba Model Studio)"),
        "gemini" => need("GEMINI_API_KEY", "Gemini"),
        "mercury" => {
            let stt = setting(settings, "sttProvider", "deepgram");
            let tts = setting(settings, "ttsProvider", "cartesia");
            stt::key_name(&stt).and_then(|k| need(k, &stt::label(&stt))).or_else(|| tts::key_name(&tts).and_then(|k| need(k, &tts::label(&tts))))
        }
        other => Some(format!("unknown voice engine \"{other}\"")),
    }
}

pub async fn open(cfg: LinkConfig) -> Result<Link, String> {
    match engine(&cfg.settings).as_str() {
        "gemini" => gemini::open(cfg).await,
        "mercury" => pipeline::open(cfg).await,
        _ => realtime::open(cfg).await,
    }
}

// ── shared helpers ────────────────────────────────────────────────────────

/// Linear resampling of mono i16 PCM.
pub fn resample(input: &[i16], from: u32, to: u32) -> Vec<i16> {
    if input.is_empty() || from == to {
        return input.to_vec();
    }
    let out_len = ((input.len() as u64 * to as u64) / from as u64).max(1) as usize;
    let step = from as f64 / to as f64;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let idx = pos as usize;
            let frac = pos - idx as f64;
            let a = input[idx.min(input.len() - 1)] as f64;
            let b = input[(idx + 1).min(input.len() - 1)] as f64;
            (a + (b - a) * frac).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect()
}

pub fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

pub fn pcm_from_bytes(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
}

pub fn b64(samples: &[i16]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(pcm_bytes(samples))
}

pub fn unb64(data: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default()
}

/// Drop a RIFF/WAV header if a provider sends one in front of raw PCM.
pub fn strip_wav(bytes: &[u8]) -> &[u8] {
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        let mut i = 12;
        while i + 8 <= bytes.len() {
            let len = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
            if &bytes[i..i + 4] == b"data" {
                return &bytes[(i + 8).min(bytes.len())..];
            }
            i += 8 + len;
        }
    }
    bytes
}

/// The language of a reply, by script: Devanagari → Hindi, Arabic script → Urdu, else English.
pub fn script_language(text: &str) -> &'static str {
    let (mut deva, mut arabic, mut latin) = (0, 0, 0);
    for c in text.chars() {
        match c as u32 {
            0x0900..=0x097F => deva += 1,
            0x0600..=0x06FF | 0x0750..=0x077F | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => arabic += 1,
            0x41..=0x5A | 0x61..=0x7A => latin += 1,
            _ => {}
        }
    }
    if deva > latin && deva >= arabic { "hi" } else if arabic > latin { "ur" } else { "en" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_lengths() {
        assert_eq!(resample(&[0i16; 960], 16_000, 24_000).len(), 1440);
        assert_eq!(resample(&[0i16; 1440], 24_000, 16_000).len(), 960);
    }

    #[test]
    fn pcm_round_trip() {
        let s = vec![0i16, 1, -1, i16::MAX, i16::MIN];
        assert_eq!(pcm_from_bytes(&unb64(&b64(&s))), s);
    }

    #[test]
    fn wav_header_is_stripped() {
        let mut wav = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0".to_vec();
        wav.extend_from_slice(&[0u8; 16]);
        wav.extend_from_slice(b"data\x04\0\0\0");
        wav.extend_from_slice(&[1, 0, 2, 0]);
        assert_eq!(strip_wav(&wav), &[1, 0, 2, 0]);
        assert_eq!(strip_wav(&[5, 6]), &[5, 6]);
    }

    #[test]
    fn languages_by_script() {
        assert_eq!(script_language("Hello there"), "en");
        assert_eq!(script_language("नमस्ते, आप कैसे हैं"), "hi");
        assert_eq!(script_language("آپ کیسے ہیں"), "ur");
    }
}
