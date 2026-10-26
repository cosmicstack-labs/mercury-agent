//! Microphone and speaker for listening mode (cpal, every OS).
//!
//! The voice links speak 16 kHz mono PCM16 in 60 ms frames (like a phone
//! call). Here the default input is mixed to mono and resampled to that, and
//! link audio is resampled to the default output's rate and played.
//!
//! Without headphones the mic would hear Mercury's own voice; `Output`
//! records when it last played sound so the session can mute the mic while
//! Mercury talks.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use tokio::sync::mpsc;

use crate::links::{CALL_RATE, resample};

/// 60 ms at 16 kHz.
pub const FRAME: usize = 960;

pub struct Output {
    queue: Mutex<VecDeque<f32>>,
    rate: u32,
    start: Instant,
    /// Milliseconds since `start` when the speaker last played sound.
    last_sound: AtomicU64,
}

impl Output {
    /// Queue link audio (16 kHz mono PCM16).
    pub fn play(&self, pcm: &[i16]) {
        let up = resample(pcm, CALL_RATE, self.rate);
        let mut q = self.queue.lock().unwrap();
        q.extend(up.iter().map(|s| *s as f32 / 32768.0));
    }

    pub fn clear(&self) {
        self.queue.lock().unwrap().clear();
    }

    /// Something is still waiting to be played.
    pub fn busy(&self) -> bool {
        !self.queue.lock().unwrap().is_empty()
    }

    /// Sound played within the last `ms` milliseconds (or still queued).
    pub fn recently_audible(&self, ms: u64) -> bool {
        self.busy() || (self.start.elapsed().as_millis() as u64).saturating_sub(self.last_sound.load(Ordering::Relaxed)) < ms
    }

    /// One soft low tone: "muted".
    pub fn mute_tone(&self) {
        let mut q = self.queue.lock().unwrap();
        let n = (self.rate as f32 * 0.12) as usize;
        for i in 0..n {
            let t = i as f32 / self.rate as f32;
            let env = (std::f32::consts::PI * i as f32 / n as f32).sin();
            q.push_back((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.14 * env);
        }
    }

    /// A short tone: rising for "listening", falling for "stopped".
    pub fn chime(&self, rising: bool) {
        let mut q = self.queue.lock().unwrap();
        let notes: [f32; 2] = if rising { [660.0, 880.0] } else { [880.0, 520.0] };
        for f in notes {
            let n = (self.rate as f32 * 0.09) as usize;
            for i in 0..n {
                let t = i as f32 / self.rate as f32;
                let env = (std::f32::consts::PI * i as f32 / n as f32).sin();
                q.push_back((2.0 * std::f32::consts::PI * f * t).sin() * 0.18 * env);
            }
        }
    }

    /// The "still working" sound: a soft wooden knock, alternating two notes
    /// ("tick… tock") so it reads as a clock, not an alarm. Peaks below the
    /// level that mutes the mic, so the owner can still say "stop" over it.
    pub fn tick(&self, tock: bool) {
        let rate = self.rate as f32;
        let f = if tock { 690.0f32 } else { 920.0 };
        let n = (rate * 0.07) as usize;
        let mut noise = 0x1234_5678u32 ^ (n as u32);
        let mut q = self.queue.lock().unwrap();
        for i in 0..n {
            let t = i as f32 / rate;
            // A struck wooden bar: the note plus an inharmonic overtone, fading fast.
            let tone = ((2.0 * std::f32::consts::PI * f * t).sin() * 0.72 + (2.0 * std::f32::consts::PI * f * 2.76 * t).sin() * 0.28) * (-t * 60.0).exp();
            // A tiny click of "contact" at the start.
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            let n_v = (noise as f32 / u32::MAX as f32 * 2.0 - 1.0) * (-t * 900.0).exp() * 0.25;
            q.push_back((tone + n_v) * 0.045);
        }
    }

    fn next(&self) -> f32 {
        let s = self.queue.lock().unwrap().pop_front();
        match s {
            Some(v) => {
                // Only real sound (speech, chimes) counts: the quiet thinking tick doesn't mute the mic.
                if v.abs() > 0.06 {
                    self.last_sound.store(self.start.elapsed().as_millis() as u64, Ordering::Relaxed);
                }
                v
            }
            None => 0.0,
        }
    }
}

pub struct Audio {
    pub mic: mpsc::UnboundedReceiver<Vec<i16>>,
    pub out: Arc<Output>,
    stop: Arc<AtomicBool>,
    pub description: String,
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Audio {
    /// Let queued sound finish (up to `max`), e.g. a goodbye before closing.
    pub async fn drain(&self, max: Duration) {
        let until = Instant::now() + max;
        while self.out.busy() && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Open the default microphone and speaker. The streams live on their own
/// thread (they aren't Send on every OS) until the returned `Audio` is dropped.
pub fn open() -> Result<Audio, String> {
    let (mic_tx, mic_rx) = mpsc::unbounded_channel::<Vec<i16>>();
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(Arc<Output>, String), String>>();
    let stop2 = stop.clone();
    std::thread::Builder::new()
        .name("optimus-audio".into())
        .spawn(move || {
            let host = cpal::default_host();
            let started = (|| -> Result<(cpal::Stream, cpal::Stream, Arc<Output>, String), String> {
                let input = host.default_input_device().ok_or("no microphone found")?;
                let output = host.default_output_device().ok_or("no speaker found")?;
                let in_cfg = input.default_input_config().map_err(|e| format!("microphone: {e}"))?;
                let out_cfg = output.default_output_config().map_err(|e| format!("speaker: {e}"))?;
                let out = Arc::new(Output {
                    queue: Mutex::new(VecDeque::new()),
                    rate: out_cfg.sample_rate().0,
                    start: Instant::now(),
                    last_sound: AtomicU64::new(0),
                });
                let in_stream = build_input(&input, &in_cfg, mic_tx)?;
                let out_stream = build_output(&output, &out_cfg, out.clone())?;
                in_stream.play().map_err(|e| format!("microphone: {e}"))?;
                out_stream.play().map_err(|e| format!("speaker: {e}"))?;
                let desc = format!(
                    "mic: {}, speaker: {}",
                    input.name().unwrap_or_else(|_| "default".into()),
                    output.name().unwrap_or_else(|_| "default".into())
                );
                Ok((in_stream, out_stream, out, desc))
            })();
            match started {
                Ok((i, o, out, desc)) => {
                    let _ = ready_tx.send(Ok((out, desc)));
                    while !stop2.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    drop(i);
                    drop(o);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let (out, description) = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the microphone didn't open in time".to_string())??;
    Ok(Audio { mic: mic_rx, out, stop, description })
}

fn build_input(device: &cpal::Device, cfg: &cpal::SupportedStreamConfig, tx: mpsc::UnboundedSender<Vec<i16>>) -> Result<cpal::Stream, String> {
    let config: cpal::StreamConfig = cfg.config();
    match cfg.sample_format() {
        SampleFormat::F32 => input_stream::<f32>(device, &config, tx, |s| s),
        SampleFormat::I16 => input_stream::<i16>(device, &config, tx, |s| s as f32 / 32768.0),
        SampleFormat::U16 => input_stream::<u16>(device, &config, tx, |s| (s as f32 - 32768.0) / 32768.0),
        SampleFormat::I32 => input_stream::<i32>(device, &config, tx, |s| s as f32 / 2147483648.0),
        other => Err(format!("unsupported microphone format {other:?}")),
    }
}

fn input_stream<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::UnboundedSender<Vec<i16>>,
    to_f32: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    let channels = config.channels.max(1) as usize;
    let rate = config.sample_rate.0;
    let chunk = (rate / 50) as usize; // 20 ms at the device rate
    let mut pending: Vec<i16> = Vec::with_capacity(chunk * 2);
    let mut frame: Vec<i16> = Vec::with_capacity(FRAME * 2);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                for f in data.chunks(channels) {
                    let m = f.iter().map(|s| to_f32(*s)).sum::<f32>() / channels as f32;
                    pending.push((m.clamp(-1.0, 1.0) * 32767.0) as i16);
                }
                while pending.len() >= chunk {
                    let part: Vec<i16> = pending.drain(..chunk).collect();
                    frame.extend(resample(&part, rate, CALL_RATE));
                    while frame.len() >= FRAME {
                        let f: Vec<i16> = frame.drain(..FRAME).collect();
                        let _ = tx.send(f);
                    }
                }
            },
            |e| eprintln!("optimus: microphone error: {e}"),
            None,
        )
        .map_err(|e| format!("microphone: {e}"))
}

fn build_output(device: &cpal::Device, cfg: &cpal::SupportedStreamConfig, out: Arc<Output>) -> Result<cpal::Stream, String> {
    let config: cpal::StreamConfig = cfg.config();
    match cfg.sample_format() {
        SampleFormat::F32 => output_stream::<f32>(device, &config, out, |v| v),
        SampleFormat::I16 => output_stream::<i16>(device, &config, out, |v| (v.clamp(-1.0, 1.0) * 32767.0) as i16),
        SampleFormat::U16 => output_stream::<u16>(device, &config, out, |v| ((v.clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16),
        SampleFormat::I32 => output_stream::<i32>(device, &config, out, |v| (v.clamp(-1.0, 1.0) as f64 * 2147483647.0) as i32),
        other => Err(format!("unsupported speaker format {other:?}")),
    }
}

fn output_stream<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    out: Arc<Output>,
    from_f32: fn(f32) -> T,
) -> Result<cpal::Stream, String> {
    let channels = config.channels.max(1) as usize;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                for f in data.chunks_mut(channels) {
                    let v = from_f32(out.next());
                    for s in f.iter_mut() {
                        *s = v;
                    }
                }
            },
            |e| eprintln!("optimus: speaker error: {e}"),
            None,
        )
        .map_err(|e| format!("speaker: {e}"))
}
