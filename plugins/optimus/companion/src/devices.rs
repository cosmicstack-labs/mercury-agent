//! What the OS lets Optimus use, which microphone it listens with, and a
//! live microphone test, for Mercury's "Microphone & permissions" screen.
//!
//! Every platform answers in the same shape, but with its own facts: macOS
//! asks per app (Optimus.app) and can prompt; Windows has privacy switches
//! and never prompts a desktop app; Linux has no permission at all, only a
//! sound server that has to be reachable. Each entry carries the exact steps
//! for this OS and version, never a generic "check your settings".
//!
//! The owner's choices (which microphone, and whether Optimus may use it at
//! all) live in `<plugin data>/devices.json`, so they apply at once, without
//! restarting the plugin.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{Value, json};

// ── The owner's choices ────────────────────────────────────────────────

pub struct Prefs {
    /// The microphone's name, or None for the system default.
    pub mic: Option<String>,
    /// Off: Optimus never opens a microphone.
    pub mic_on: bool,
}

fn data_dir() -> PathBuf {
    std::env::var_os("MERCURY_PLUGIN_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_else(|| ".".into());
        PathBuf::from(home).join(".mercury").join("optimus")
    })
}

fn prefs_path() -> PathBuf {
    data_dir().join("devices.json")
}

pub fn prefs() -> Prefs {
    let v: Value = std::fs::read_to_string(prefs_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    Prefs {
        mic: v.get("microphone").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        mic_on: v.get("microphoneOn").and_then(Value::as_bool).unwrap_or(true),
    }
}

/// Change what the owner picked: `microphone` (a name, or "" for the system default) and/or `microphoneOn`.
pub fn select(args: &Value) -> Result<Value, String> {
    let mut p = prefs();
    if let Some(m) = args.get("microphone") {
        let name = m.as_str().map(str::trim).unwrap_or("");
        if !name.is_empty() && !input_names().iter().any(|n| n == name) {
            return Err(format!("There's no microphone called \"{name}\" on this computer right now."));
        }
        p.mic = if name.is_empty() { None } else { Some(name.to_string()) };
    }
    if let Some(on) = args.get("microphoneOn").and_then(Value::as_bool) {
        p.mic_on = on;
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't save the microphone choice: {e}"))?;
    let body = json!({ "microphone": p.mic.clone().unwrap_or_default(), "microphoneOn": p.mic_on });
    std::fs::write(prefs_path(), format!("{body}\n")).map_err(|e| format!("can't save the microphone choice: {e}"))?;
    Ok(status())
}

// ── Microphones ────────────────────────────────────────────────────────

fn input_names() -> Vec<String> {
    let host = cpal::default_host();
    let mut names: Vec<String> = host.input_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default();
    names.dedup();
    names
}

/// The microphone Optimus will open: the owner's pick if it's connected, else the system default.
/// The note says why it isn't the pick (unplugged), when that happens.
pub fn input_device() -> Result<(cpal::Device, Option<String>), String> {
    let host = cpal::default_host();
    let p = prefs();
    if let Some(want) = &p.mic {
        if let Some(d) = host.input_devices().ok().and_then(|mut it| it.find(|d| d.name().ok().as_deref() == Some(want.as_str()))) {
            return Ok((d, None));
        }
        let d = host.default_input_device().ok_or_else(no_microphone)?;
        let using = d.name().unwrap_or_else(|_| "the default microphone".into());
        return Ok((d, Some(format!("\"{want}\" isn't connected, so Optimus is using {using}."))));
    }
    Ok((host.default_input_device().ok_or_else(no_microphone)?, None))
}

fn no_microphone() -> String {
    if cfg!(target_os = "macos") {
        "This Mac has no microphone connected (or macOS hides it). Plug one in, or check System Settings → Sound → Input.".into()
    } else if cfg!(windows) {
        "Windows has no microphone enabled. Plug one in, or open Settings → System → Sound → Input and pick or enable a microphone.".into()
    } else {
        format!("No microphone found. {}", linux_audio_steps().join(" "))
    }
}

fn microphones() -> Value {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let p = prefs();
    let list: Vec<Value> = input_names()
        .into_iter()
        .map(|n| json!({ "name": n, "default": default.as_deref() == Some(n.as_str()) }))
        .collect();
    let connected = p.mic.as_ref().map(|m| list.iter().any(|d| d["name"].as_str() == Some(m.as_str())));
    json!({
        "devices": list,
        "systemDefault": default,
        "selected": p.mic,
        "selectedConnected": connected.unwrap_or(true),
        "on": p.mic_on,
    })
}

// ── Status ─────────────────────────────────────────────────────────────

/// One permission, as the app shows it.
/// state: granted | not-asked | denied | restricted | limited | unavailable
fn entry(kind: &str, label: &str, state: &str, detail: String, steps: Vec<String>, can_request: bool, settings: Option<&str>, used: bool) -> Value {
    json!({
        "kind": kind,
        "label": label,
        "state": state,
        "detail": detail,
        "steps": steps,
        "canRequest": can_request,
        "canOpenSettings": settings.is_some(),
        "used": used,
    })
}

pub fn status() -> Value {
    json!({
        "platform": platform_name(),
        "permissions": permissions(),
        "microphones": microphones(),
    })
}

/// Ask for one permission (where the OS can ask), else open the right settings page.
pub fn request(args: &Value) -> Result<Value, String> {
    let kind = args.get("kind").and_then(Value::as_str).unwrap_or("");
    let open = args.get("openSettings").and_then(Value::as_bool).unwrap_or(false);
    platform_request(kind, open)?;
    Ok(status())
}

/// Ready to listen? Called before a voice session opens the microphone, so a
/// blocked microphone says so instead of delivering silence.
pub fn mic_ready() -> Result<(), String> {
    if !prefs().mic_on {
        return Err("The microphone is off for Optimus. Turn it on in Mercury → Settings → AI → Voice → Microphone.".into());
    }
    platform_mic_ready()
}

/// The microphone permission on macOS: granted | not-asked | denied | restricted.
#[cfg(target_os = "macos")]
pub fn mic_state() -> &'static str {
    use objc2_av_foundation::AVAuthorizationStatus as S;
    match os::auth(false) {
        S::Authorized => "granted",
        S::Denied => "denied",
        S::Restricted => "restricted",
        _ => "not-asked",
    }
}

#[cfg(target_os = "macos")]
pub fn ask_microphone() -> bool {
    os::ask_microphone()
}

// ── Microphone test ────────────────────────────────────────────────────

/// Listen for `seconds` on the chosen microphone (no speaker, no voice link),
/// reporting the level every 80 ms through `level`, then sum it up.
pub fn mic_test(args: &Value, level: impl Fn(f32)) -> Result<Value, String> {
    platform_mic_ready()?;
    let seconds = args.get("seconds").and_then(Value::as_f64).unwrap_or(5.0).clamp(1.0, 15.0);
    let (device, note) = input_device()?;
    let name = device.name().unwrap_or_else(|_| "microphone".into());
    let cfg = device.default_input_config().map_err(|e| format!("{name}: {e}"))?;
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let frames = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let stream = {
        let peak = peak.clone();
        let frames = frames.clone();
        let channels = cfg.channels().max(1) as usize;
        let config: cpal::StreamConfig = cfg.config();
        let on_err = |e| crate::core::log(format!("mic test: {e}"));
        macro_rules! build {
            ($t:ty, $f:expr) => {
                device.build_input_stream(
                    &config,
                    move |data: &[$t], _| {
                        let mut p = 0f32;
                        for f in data.chunks(channels) {
                            let m = (f.iter().map(|s| $f(*s)).sum::<f32>() / channels as f32).abs();
                            if m > p {
                                p = m;
                            }
                        }
                        frames.fetch_add(data.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        if p > f32::from_bits(peak.load(std::sync::atomic::Ordering::Relaxed)) {
                            peak.store(p.to_bits(), std::sync::atomic::Ordering::Relaxed);
                        }
                    },
                    on_err,
                    None,
                )
            };
        }
        match cfg.sample_format() {
            cpal::SampleFormat::F32 => build!(f32, |s: f32| s),
            cpal::SampleFormat::I16 => build!(i16, |s: i16| s as f32 / 32768.0),
            cpal::SampleFormat::U16 => build!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
            cpal::SampleFormat::I32 => build!(i32, |s: i32| s as f32 / 2147483648.0),
            other => return Err(format!("{name} uses a sample format Optimus can't read ({other:?})")),
        }
        .map_err(|e| format!("{name}: {e}"))?
    };
    stream.play().map_err(|e| format!("{name}: {e}"))?;
    let until = Instant::now() + Duration::from_secs_f64(seconds);
    let mut loudest = 0f32;
    let mut sum = 0f32;
    let mut ticks = 0u32;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(80));
        let p = f32::from_bits(peak.swap(0, std::sync::atomic::Ordering::Relaxed));
        // The same scale as a voice session's level (peak × 3), so the meter reads alike.
        let l = (p * 3.0).min(1.0);
        level(l);
        loudest = loudest.max(p);
        sum += l;
        ticks += 1;
    }
    drop(stream);
    let got_audio = frames.load(std::sync::atomic::Ordering::Relaxed) > 0;
    let silent = loudest == 0.0;
    let heard = loudest > 0.02;
    let mut summary = if !got_audio {
        format!("{name} didn't send any sound at all.")
    } else if silent {
        format!("{name} sent pure silence: something is blocking or muting it.")
    } else if heard {
        format!("{name} works: Optimus heard you.")
    } else {
        format!("{name} is on, but very quiet: Optimus barely heard anything.")
    };
    if let Some(n) = &note {
        summary = format!("{n} {summary}");
    }
    let steps = if silent || !got_audio { silent_steps(&name) } else if !heard { quiet_steps(&name) } else { Vec::new() };
    Ok(json!({
        "device": name,
        "peak": (loudest * 3.0).min(1.0),
        "average": if ticks > 0 { sum / ticks as f32 } else { 0.0 },
        "heard": heard,
        "silent": silent || !got_audio,
        "text": summary,
        "steps": steps,
    }))
}

// ── macOS ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio, AVMediaTypeVideo};
    use std::process::Command;

    pub const PANE_MIC: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    pub const PANE_CAMERA: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera";
    pub const PANE_SCREEN: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    pub const PANE_AX: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    pub fn major() -> u32 {
        Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| v.trim().split('.').next().and_then(|m| m.parse().ok()))
            .unwrap_or(14)
    }

    /// "System Settings → Privacy & Security" on macOS 13+, "System Preferences → Security & Privacy → Privacy" before.
    pub fn privacy(list: &str) -> String {
        if major() >= 13 {
            format!("Open System Settings → Privacy & Security → {list}.")
        } else {
            format!("Open System Preferences → Security & Privacy → Privacy tab → {list} (click the lock to make changes).")
        }
    }

    pub fn screen_list() -> &'static str {
        if major() >= 15 { "Screen & System Audio Recording" } else { "Screen Recording" }
    }

    pub fn auth(video: bool) -> AVAuthorizationStatus {
        // SAFETY: plain class method calls with constants AVFoundation defines.
        unsafe {
            let media = if video { AVMediaTypeVideo } else { AVMediaTypeAudio };
            match media {
                Some(m) => AVCaptureDevice::authorizationStatusForMediaType(m),
                None => AVAuthorizationStatus::NotDetermined,
            }
        }
    }

    /// Show macOS's microphone prompt for Optimus and wait for the answer (up to a minute).
    pub fn ask_microphone() -> bool {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let block = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: AVMediaTypeAudio is AVFoundation's constant; the block outlives the call (RcBlock is retained by AVFoundation).
        unsafe {
            if let Some(m) = AVMediaTypeAudio {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(m, &block);
            } else {
                return false;
            }
        }
        rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false)
    }

    pub fn open(pane: &str) {
        let _ = Command::new("open").arg(pane).status();
    }

    pub fn mic_entry() -> Value {
        let list = "Microphone";
        match auth(false) {
            AVAuthorizationStatus::Authorized => entry("microphone", "Microphone", "granted", "Optimus may use the microphone.".into(), vec![], false, Some(PANE_MIC), true),
            AVAuthorizationStatus::Denied => entry(
                "microphone",
                "Microphone",
                "denied",
                "macOS is blocking the microphone for Optimus, so it hears only silence.".into(),
                vec![privacy(list), "Turn on Optimus.".into(), "Come back here and press Test: the bar should move when you speak.".into()],
                false,
                Some(PANE_MIC),
                true,
            ),
            AVAuthorizationStatus::Restricted => entry(
                "microphone",
                "Microphone",
                "restricted",
                "This Mac doesn't let apps ask for the microphone: a device-management profile or Screen Time restricts it.".into(),
                vec![
                    if major() >= 13 { "Open System Settings → Screen Time → Content & Privacy → App Restrictions (or Privacy) and allow microphone changes." } else { "Open System Preferences → Screen Time → Content & Privacy → Apps and allow microphone changes." }.into(),
                    "If this Mac is managed by an organisation, ask its administrator to allow the microphone for Optimus (bundle id sh.mercuryagent.optimus).".into(),
                ],
                false,
                Some(PANE_MIC),
                true,
            ),
            _ => entry(
                "microphone",
                "Microphone",
                "not-asked",
                "macOS hasn't asked you yet whether Optimus may use the microphone.".into(),
                vec!["Press Allow: macOS shows its prompt for Optimus. Choose Allow.".into()],
                true,
                Some(PANE_MIC),
                true,
            ),
        }
    }

    pub fn permissions() -> Vec<Value> {
        let (ax, screen) = unsafe { (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()) };
        let screen_list = screen_list();
        let camera = match auth(true) {
            AVAuthorizationStatus::Authorized => "granted",
            AVAuthorizationStatus::Denied => "denied",
            AVAuthorizationStatus::Restricted => "restricted",
            _ => "not-asked",
        };
        vec![
            mic_entry(),
            if screen {
                entry("screen", screen_list, "granted", "Optimus can see the screen.".into(), vec![], false, Some(PANE_SCREEN), true)
            } else {
                entry(
                    "screen",
                    screen_list,
                    "denied",
                    "Optimus can't see the screen until it's allowed.".into(),
                    vec![
                        "Press Allow: macOS adds Optimus to the list and opens it.".into(),
                        privacy(screen_list),
                        "Turn on Optimus. If macOS offers \"Quit & Reopen\", choose Later: Optimus restarts by itself the next time it's used.".into(),
                        "macOS asks you to confirm this again about once a month.".into(),
                    ],
                    true,
                    Some(PANE_SCREEN),
                    true,
                )
            },
            if ax {
                entry("accessibility", "Accessibility", "granted", "Optimus can use the mouse and keyboard.".into(), vec![], false, Some(PANE_AX), true)
            } else {
                entry(
                    "accessibility",
                    "Accessibility",
                    "denied",
                    "Optimus can't use the mouse and keyboard until it's allowed.".into(),
                    vec![
                        "Press Allow: macOS adds Optimus to the list and opens it.".into(),
                        privacy("Accessibility"),
                        "Turn on Optimus.".into(),
                        "Already on but still red? Select Optimus, remove it with the − button, then press Allow here again (an Optimus update can leave a stale entry).".into(),
                    ],
                    true,
                    Some(PANE_AX),
                    true,
                )
            },
            entry(
                "camera",
                "Camera",
                camera,
                "No Optimus feature uses the camera yet.".into(),
                if camera == "denied" { vec![privacy("Camera"), "Turn on the app that needs it.".into()] } else { vec![] },
                false,
                Some(PANE_CAMERA),
                false,
            ),
        ]
    }

    pub fn request(kind: &str, open_settings: bool) -> Result<(), String> {
        match kind {
            "microphone" => {
                if open_settings || auth(false) != AVAuthorizationStatus::NotDetermined {
                    open(PANE_MIC);
                } else if !ask_microphone() {
                    open(PANE_MIC);
                }
            }
            "screen" | "accessibility" => {
                // The existing request flow registers Optimus in the list, prompts once and opens the pane.
                let _ = crate::mac::permission_report(true);
                if open_settings {
                    open(if kind == "screen" { PANE_SCREEN } else { PANE_AX });
                }
            }
            "camera" => open(PANE_CAMERA),
            other => return Err(format!("unknown permission {other}")),
        }
        Ok(())
    }

    pub fn mic_ready() -> Result<(), String> {
        match auth(false) {
            AVAuthorizationStatus::Authorized => Ok(()),
            AVAuthorizationStatus::NotDetermined => {
                if ask_microphone() {
                    Ok(())
                } else {
                    open(PANE_MIC);
                    Err(format!("macOS didn't allow the microphone for Optimus. {} Turn on Optimus, then try again.", privacy("Microphone")))
                }
            }
            AVAuthorizationStatus::Restricted => Err("This Mac restricts the microphone (Screen Time or a device-management profile), so Optimus can't use it.".into()),
            _ => {
                open(PANE_MIC);
                Err(format!("macOS is blocking the microphone for Optimus. {} Turn on Optimus, then try again.", privacy("Microphone")))
            }
        }
    }

    pub fn silent_steps(name: &str) -> Vec<String> {
        let mut steps = Vec::new();
        if auth(false) != AVAuthorizationStatus::Authorized {
            steps.push(privacy("Microphone"));
            steps.push("Turn on Optimus.".into());
        }
        steps.push(format!(
            "{} pick {name} and speak: its Input level should move. If the Input volume slider is all the way left, drag it right.",
            if major() >= 13 { "Open System Settings → Sound → Input," } else { "Open System Preferences → Sound → Input," }
        ));
        steps.push("A headset or USB mic may have its own mute switch or button: check it's not muted.".into());
        steps
    }

    pub fn quiet_steps(name: &str) -> Vec<String> {
        vec![format!(
            "{} select {name} and drag the Input volume slider further right.",
            if major() >= 13 { "Open System Settings → Sound → Input," } else { "Open System Preferences → Sound → Input," }
        )]
    }
}

// ── Windows ────────────────────────────────────────────────────────────

#[cfg(windows)]
mod os {
    use super::*;
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};

    const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
        let (k, v) = (wide(key), wide(value));
        let mut buf = vec![0u16; 256];
        let mut len = (buf.len() * 2) as u32;
        // SAFETY: buffers are valid for the sizes passed.
        let r = unsafe { RegGetValueW(root, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len) };
        if r != 0 {
            return None;
        }
        let n = (len as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..n.min(buf.len())]))
    }

    pub fn windows_11() -> bool {
        reg_string(HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")
            .and_then(|b| b.trim().parse::<u32>().ok())
            .map(|b| b >= 22000)
            .unwrap_or(true)
    }

    /// The three switches that decide whether a desktop app may use a device:
    /// the device-wide one (admin), the per-user one, and "desktop apps".
    fn consent(cap: &str) -> (bool, bool, bool) {
        let deny = |root, key: String| reg_string(root, &key, "Value").map(|v| v.eq_ignore_ascii_case("Deny")).unwrap_or(false);
        (
            deny(HKEY_LOCAL_MACHINE, format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{cap}")),
            deny(HKEY_CURRENT_USER, format!(r"{CONSENT}\{cap}")),
            deny(HKEY_CURRENT_USER, format!(r"{CONSENT}\{cap}\NonPackaged")),
        )
    }

    fn device_steps(cap: &str, noun: &str, page: &str) -> Vec<String> {
        let (device_off, user_off, desktop_off) = consent(cap);
        let mut steps = Vec::new();
        if windows_11() {
            steps.push(format!("Open Settings → Privacy & security → {page}."));
            if device_off || user_off {
                steps.push(format!("Turn on \"{page} access\"{}.", if device_off { " (needs an administrator account)" } else { "" }));
                steps.push(format!("Turn on \"Let apps access your {noun}\"."));
            }
            if desktop_off || steps.len() == 1 {
                steps.push(format!("Scroll down and turn on \"Let desktop apps access your {noun}\" (Optimus is a desktop app, so it isn't listed by name)."));
            }
        } else {
            steps.push(format!("Open Settings → Privacy → {page}."));
            if device_off {
                steps.push(format!("Under \"Allow access to the {noun} on this device\", click Change and turn it on (needs an administrator account)."));
            }
            if user_off {
                steps.push(format!("Turn on \"Allow apps to access your {noun}\"."));
            }
            if desktop_off || steps.len() == 1 {
                steps.push(format!("Scroll down and turn on \"Allow desktop apps to access your {noun}\" (Optimus is a desktop app, so it isn't listed by name)."));
            }
        }
        steps
    }

    pub fn mic_entry() -> Value {
        let (a, b, c) = consent("microphone");
        if a || b || c {
            entry(
                "microphone",
                "Microphone",
                "denied",
                "Windows privacy settings block desktop apps, including Optimus, from the microphone.".into(),
                device_steps("microphone", "microphone", "Microphone"),
                false,
                Some("ms-settings:privacy-microphone"),
                true,
            )
        } else {
            entry("microphone", "Microphone", "granted", "Windows lets desktop apps, including Optimus, use the microphone. Windows never asks per app.".into(), vec![], false, Some("ms-settings:privacy-microphone"), true)
        }
    }

    pub fn permissions() -> Vec<Value> {
        let (a, b, c) = consent("webcam");
        let camera_off = a || b || c;
        vec![
            mic_entry(),
            entry("screen", "Screen", "granted", "Windows doesn't need a permission for Optimus to see the screen.".into(), vec![], false, None, true),
            entry(
                "accessibility",
                "Mouse and keyboard",
                "granted",
                "Optimus can use the mouse and keyboard. Windows of apps running as administrator (Task Manager, installers) ignore it unless Optimus also runs as administrator.".into(),
                vec![],
                false,
                None,
                true,
            ),
            entry(
                "camera",
                "Camera",
                if camera_off { "denied" } else { "granted" },
                "No Optimus feature uses the camera yet.".into(),
                if camera_off { device_steps("webcam", "camera", "Camera") } else { vec![] },
                false,
                Some("ms-settings:privacy-webcam"),
                false,
            ),
        ]
    }

    pub fn open(uri: &str) {
        let _ = std::process::Command::new("explorer.exe").arg(uri).status();
    }

    pub fn request(kind: &str, _open_settings: bool) -> Result<(), String> {
        match kind {
            // Windows never prompts a desktop app: the switches live in Settings.
            "microphone" => open("ms-settings:privacy-microphone"),
            "camera" => open("ms-settings:privacy-webcam"),
            "screen" | "accessibility" => {}
            other => return Err(format!("unknown permission {other}")),
        }
        Ok(())
    }

    pub fn mic_ready() -> Result<(), String> {
        let (a, b, c) = consent("microphone");
        if a || b || c {
            open("ms-settings:privacy-microphone");
            return Err(format!("Windows is blocking the microphone for desktop apps. {}", device_steps("microphone", "microphone", "Microphone").join(" ")));
        }
        Ok(())
    }

    pub fn silent_steps(name: &str) -> Vec<String> {
        let mut steps = Vec::new();
        let (a, b, c) = consent("microphone");
        if a || b || c {
            steps.extend(device_steps("microphone", "microphone", "Microphone"));
        }
        steps.push(format!(
            "Open Settings → System → Sound → Input, select {name} and speak: the level bar should move. Raise Input volume if it's at 0."
        ));
        steps.push(format!("Still silent? In the same page open {name}'s properties and make sure it isn't disabled, or pick another microphone above."));
        steps.push("A headset or USB mic may have its own mute switch or button: check it's not muted.".into());
        steps
    }

    pub fn quiet_steps(name: &str) -> Vec<String> {
        vec![format!("Open Settings → System → Sound → Input, select {name} and raise Input volume.")]
    }
}

// ── Linux ──────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod os {
    use super::*;

    fn desktop() -> String {
        std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase()
    }

    pub fn wayland() -> bool {
        std::env::var("XDG_SESSION_TYPE").map(|s| s == "wayland").unwrap_or(false) || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    /// Where the sound server listens: PipeWire, or PulseAudio (also what pipewire-pulse provides).
    fn sound_server() -> Option<&'static str> {
        if std::env::var_os("PULSE_SERVER").is_some() {
            return Some("PulseAudio");
        }
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)?;
        if dir.join("pipewire-0").exists() {
            Some("PipeWire")
        } else if dir.join("pulse").join("native").exists() {
            Some("PulseAudio")
        } else {
            None
        }
    }

    pub fn mic_entry() -> Value {
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            return entry(
                "microphone",
                "Microphone",
                "unavailable",
                "Optimus was started without your desktop session's details (XDG_RUNTIME_DIR), so it can't reach the sound server.".into(),
                vec![
                    "Update Mercury: newer versions pass the session's audio details to plugins.".into(),
                    "Then restart Mercury from a terminal inside your desktop session: mercury restart".into(),
                ],
                false,
                None,
                true,
            );
        }
        match sound_server() {
            Some(server) => entry(
                "microphone",
                "Microphone",
                "granted",
                format!("Linux doesn't ask apps for microphone permission. Optimus reaches it through {server}."),
                vec![],
                false,
                None,
                true,
            ),
            None => entry(
                "microphone",
                "Microphone",
                "unavailable",
                "No PipeWire or PulseAudio sound server is running in this session, so Optimus can only use raw ALSA devices.".into(),
                vec![
                    "Start PipeWire: systemctl --user enable --now pipewire pipewire-pulse wireplumber".into(),
                    "Or, on a PulseAudio system: pulseaudio --start".into(),
                    "Then press Recheck.".into(),
                ],
                false,
                None,
                true,
            ),
        }
    }

    fn x11_session_steps() -> Vec<String> {
        let d = desktop();
        let session = if d.contains("gnome") || d.contains("ubuntu") {
            "\"GNOME on Xorg\" (Ubuntu: \"Ubuntu on Xorg\")"
        } else if d.contains("kde") {
            "\"Plasma (X11)\""
        } else {
            "an X11 (Xorg) session"
        };
        vec![
            "Log out.".into(),
            format!("On the login screen, click your name, then the gear (or session menu) in the corner, and choose {session}."),
            "Log in and press Recheck.".into(),
        ]
    }

    pub fn permissions() -> Vec<Value> {
        let w = wayland();
        vec![
            mic_entry(),
            if w {
                entry(
                    "screen",
                    "Screen",
                    "limited",
                    "Wayland: every screenshot goes through your desktop's screen-sharing prompt.".into(),
                    x11_session_steps(),
                    false,
                    None,
                    true,
                )
            } else {
                entry("screen", "Screen", "granted", "X11: Optimus can see the screen. Linux doesn't need a permission for it.".into(), vec![], false, None, true)
            },
            if w {
                entry(
                    "accessibility",
                    "Mouse and keyboard",
                    "limited",
                    "Wayland: Optimus can only click and type in X11 (XWayland) apps, not native Wayland ones.".into(),
                    x11_session_steps(),
                    false,
                    None,
                    true,
                )
            } else {
                entry("accessibility", "Mouse and keyboard", "granted", "X11: Optimus can use the mouse and keyboard.".into(), vec![], false, None, true)
            },
            entry("camera", "Camera", "granted", "Linux doesn't ask apps for camera permission. No Optimus feature uses the camera yet.".into(), vec![], false, None, false),
        ]
    }

    pub fn request(kind: &str, _open_settings: bool) -> Result<(), String> {
        match kind {
            "microphone" | "screen" | "accessibility" | "camera" => Ok(()),
            other => Err(format!("unknown permission {other}")),
        }
    }

    /// Linux has no microphone permission to refuse, and a raw ALSA device can still work without
    /// a sound server (or under an older Mercury that doesn't pass the session's details): never
    /// block a session here, just say what looks wrong. A silent mic still shows in the app's test.
    pub fn mic_ready() -> Result<(), String> {
        let e = mic_entry();
        if e["state"] != "granted" {
            crate::core::log(format!("microphone: {}", e["detail"].as_str().unwrap_or("")));
        }
        Ok(())
    }

    pub fn audio_steps() -> Vec<String> {
        let d = desktop();
        let mut steps = Vec::new();
        if d.contains("gnome") || d.contains("ubuntu") || d.contains("unity") || d.contains("cinnamon") || d.contains("budgie") {
            steps.push("Open Settings → Sound → Input, choose the microphone and speak: the input level bar should move. Raise Volume and make sure it isn't muted.".into());
        } else if d.contains("kde") {
            steps.push("Open System Settings → Sound (Audio) → Input Devices, choose the microphone, unmute it and raise its volume.".into());
        } else if d.contains("xfce") || d.contains("lxqt") || d.contains("lxde") || d.contains("mate") {
            steps.push("Open PulseAudio Volume Control (pavucontrol) → Input Devices: unmute the microphone (speaker icon), raise its level, and click the ✓ to make it the fallback.".into());
        } else {
            steps.push("Open pavucontrol (PulseAudio Volume Control) → Input Devices: unmute the microphone, raise its level and set it as fallback.".into());
        }
        steps.push("Still silent? Run alsamixer in a terminal, press F4 (Capture), select the microphone and press Space so it shows CAPTURE, then raise it with ↑.".into());
        steps
    }

    pub fn silent_steps(_name: &str) -> Vec<String> {
        let mut steps = Vec::new();
        if mic_entry()["state"] != "granted" {
            steps.extend(mic_entry()["steps"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default());
        }
        steps.extend(audio_steps());
        steps.push("A headset or USB mic may have its own mute switch or button: check it's not muted.".into());
        steps
    }

    pub fn quiet_steps(_name: &str) -> Vec<String> {
        audio_steps().into_iter().take(1).collect()
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod os {
    use super::*;
    pub fn permissions() -> Vec<Value> {
        vec![]
    }
    pub fn request(_: &str, _: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn mic_ready() -> Result<(), String> {
        Ok(())
    }
    pub fn silent_steps(_: &str) -> Vec<String> {
        vec![]
    }
    pub fn quiet_steps(_: &str) -> Vec<String> {
        vec![]
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn permissions() -> Vec<Value> {
    os::permissions()
}

fn platform_request(kind: &str, open: bool) -> Result<(), String> {
    os::request(kind, open)
}

fn platform_mic_ready() -> Result<(), String> {
    os::mic_ready()
}

fn silent_steps(name: &str) -> Vec<String> {
    os::silent_steps(name)
}

fn quiet_steps(name: &str) -> Vec<String> {
    os::quiet_steps(name)
}

#[cfg(target_os = "linux")]
fn linux_audio_steps() -> Vec<String> {
    os::audio_steps()
}

#[cfg(not(target_os = "linux"))]
fn linux_audio_steps() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_round_trip() {
        let dir = std::env::temp_dir().join(format!("optimus-devices-{}", std::process::id()));
        // SAFETY: tests in this module run on one thread for this variable.
        unsafe { std::env::set_var("MERCURY_PLUGIN_DATA_DIR", &dir) };
        assert!(prefs().mic_on, "on by default");
        assert!(prefs().mic.is_none(), "system default by default");
        select(&json!({ "microphoneOn": false })).unwrap();
        assert!(!prefs().mic_on);
        assert!(select(&json!({ "microphone": "No Such Microphone 9000" })).is_err(), "an unknown microphone is refused");
        select(&json!({ "microphone": "", "microphoneOn": true })).unwrap();
        assert!(prefs().mic_on && prefs().mic.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_shape() {
        let s = status();
        assert!(s["platform"].is_string());
        let perms = s["permissions"].as_array().unwrap();
        for kind in ["microphone", "screen", "accessibility", "camera"] {
            let p = perms.iter().find(|p| p["kind"] == kind).unwrap_or_else(|| panic!("{kind} missing"));
            assert!(["granted", "not-asked", "denied", "restricted", "limited", "unavailable"].contains(&p["state"].as_str().unwrap()));
            // Anything not granted says exactly what to do.
            if p["state"] != "granted" && p["kind"] != "camera" {
                assert!(!p["steps"].as_array().unwrap().is_empty() || p["canRequest"] == true, "{kind} has no steps");
            }
        }
        assert!(s["microphones"]["devices"].is_array());
    }
}
