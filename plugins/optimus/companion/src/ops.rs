//! What Optimus does to the computer: screenshots, mouse, keyboard, apps.
//!
//! Every operation takes JSON arguments and returns JSON:
//!   { "text": "...", "image": { "data": <base64>, "mimeType": "image/jpeg" } }
//! (image optional). On macOS this runs inside Optimus.app (see mac.rs), so
//! the OS permissions belong to Optimus; elsewhere it runs in the plugin
//! process itself.
//!
//! Coordinates the model sends are pixels in the most recent screenshot.
//! They're mapped back to the screen through the geometry of that shot, so
//! HiDPI scaling and multi-monitor offsets never reach the model.

use std::time::{Duration, Instant};

use base64::Engine as _;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{Value, json};
use xcap::image::{DynamicImage, RgbaImage, codecs::jpeg::JpegEncoder, imageops::FilterType};
use xcap::{Monitor, Window};

/// Screenshots fit in this box (what computer-use models are tuned for).
const MAX_W: u32 = 1280;
const MAX_H: u32 = 800;
const JPEG_QUALITY: u8 = 80;
/// The user moving the mouse this far during a batch stops Optimus.
const TAKEOVER_PX: i32 = 12;
const MAX_ACTIONS: usize = 60;
/// Points in one freehand stroke.
const MAX_DRAW_POINTS: usize = 2000;
/// Typed key by key at a human pace: ~3,000 characters is a few minutes, inside one tool call.
const MAX_TYPE_CHARS: usize = 3_000;

/// Where the last screenshot came from, to map its pixels back to the screen.
#[derive(Clone, Copy)]
struct Shot {
    monitor: usize,
    /// Monitor origin and size in input coordinates (points on macOS, pixels elsewhere).
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    /// The screenshot's size as the model saw it.
    img_w: u32,
    img_h: u32,
}

impl Shot {
    fn to_screen(&self, px: f64, py: f64) -> Result<(i32, i32), String> {
        if !(0.0..=self.img_w as f64).contains(&px) || !(0.0..=self.img_h as f64).contains(&py) {
            return Err(format!(
                "({px}, {py}) is outside the last screenshot ({}×{}); use coordinates from the latest screenshot",
                self.img_w, self.img_h
            ));
        }
        let sx = self.x as f64 + px * self.w as f64 / self.img_w as f64;
        let sy = self.y as f64 + py * self.h as f64 / self.img_h as f64;
        Ok((sx.round() as i32, sy.round() as i32))
    }
    fn to_image(&self, sx: i32, sy: i32) -> Option<(i64, i64)> {
        let px = (sx - self.x) as f64 * self.img_w as f64 / self.w as f64;
        let py = (sy - self.y) as f64 * self.img_h as f64 / self.h as f64;
        if px < 0.0 || py < 0.0 || px > self.img_w as f64 || py > self.img_h as f64 {
            return None;
        }
        Some((px.round() as i64, py.round() as i64))
    }
}

pub struct Ops {
    enigo: Option<Enigo>,
    shot: Option<Shot>,
}

pub type OpResult = Result<Value, String>;

impl Default for Ops {
    fn default() -> Self {
        Self::new()
    }
}

impl Ops {
    pub fn new() -> Self {
        #[cfg(windows)]
        unsafe {
            // Real pixels everywhere: otherwise Windows scales coordinates and captures.
            use windows_sys::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Ops { enigo: None, shot: None }
    }

    fn enigo(&mut self) -> Result<&mut Enigo, String> {
        if self.enigo.is_none() {
            let settings = Settings { open_prompt_to_get_permissions: false, ..Settings::default() };
            self.enigo = Some(Enigo::new(&settings).map_err(|e| format!("can't control the mouse and keyboard: {e}{}", permission_hint()))?);
        }
        Ok(self.enigo.as_mut().unwrap())
    }

    fn cursor(&mut self) -> Option<(i32, i32)> {
        self.enigo().ok()?.location().ok()
    }

    pub fn run(&mut self, op: &str, args: &Value) -> OpResult {
        match op {
            "look" => self.look(args),
            "act" => self.act(args),
            "open" => open_target(args),
            "windows" => windows(),
            "permissions" => self.permissions(args),
            other => Err(format!("unknown operation {other}")),
        }
    }

    // ── Seeing ─────────────────────────────────────────────────────────

    fn pick_monitor(&mut self, args: &Value) -> Result<(usize, Monitor), String> {
        let monitors = Monitor::all().map_err(|e| capture_error(&e.to_string()))?;
        if monitors.is_empty() {
            return Err("no display found".into());
        }
        if let Some(n) = args.get("display").and_then(Value::as_u64) {
            let i = (n as usize).saturating_sub(1);
            return monitors.into_iter().enumerate().nth(i).ok_or_else(|| format!("there is no display {n}"));
        }
        // Default: the display the cursor is on, else the main one.
        let cursor = self.cursor();
        let idx = monitors
            .iter()
            .position(|m| match (cursor, m.x(), m.y(), m.width(), m.height()) {
                (Some((cx, cy)), Ok(x), Ok(y), Ok(w), Ok(h)) => cx >= x && cy >= y && cx < x + w as i32 && cy < y + h as i32,
                _ => false,
            })
            .or_else(|| monitors.iter().position(|m| m.is_primary().unwrap_or(false)))
            .unwrap_or(0);
        Ok((idx, monitors.into_iter().nth(idx).unwrap()))
    }

    fn look(&mut self, args: &Value) -> OpResult {
        let display = match (args.get("display"), self.shot) {
            (Some(d), _) => d.clone(),
            (None, Some(s)) if args.get("zoom").is_some() => json!(s.monitor + 1),
            _ => Value::Null,
        };
        let (idx, mon) = self.pick_monitor(&json!({ "display": display }))?;
        let count = Monitor::all().map(|m| m.len()).unwrap_or(1);
        let (x, y, w, h) = (
            mon.x().map_err(err)?,
            mon.y().map_err(err)?,
            mon.width().map_err(err)?,
            mon.height().map_err(err)?,
        );
        let full = {
            let _hidden = crate::overlay::capture_guard();
            mon.capture_image().map_err(|e| capture_error(&e.to_string()))?
        };

        // Zoom: a closer look at part of the last screenshot. Coordinates keep
        // referring to the full screenshot, so the zoom never moves the frame.
        if let Some(z) = args.get("zoom").and_then(Value::as_array) {
            let shot = self.shot.ok_or("take a screenshot (look) before zooming")?;
            let n: Vec<f64> = z.iter().filter_map(Value::as_f64).collect();
            if n.len() != 4 || n[2] <= n[0] || n[3] <= n[1] {
                return Err("zoom is [x0, y0, x1, y1] in the last screenshot's pixels".into());
            }
            let fx = full.width() as f64 / shot.img_w as f64;
            let fy = full.height() as f64 / shot.img_h as f64;
            let (cx, cy) = ((n[0] * fx).max(0.0) as u32, (n[1] * fy).max(0.0) as u32);
            let cw = (((n[2] - n[0]) * fx) as u32).clamp(1, full.width().saturating_sub(cx).max(1));
            let ch = (((n[3] - n[1]) * fy) as u32).clamp(1, full.height().saturating_sub(cy).max(1));
            let crop = xcap::image::imageops::crop_imm(&full, cx, cy, cw, ch).to_image();
            let (img, iw, ih) = fit(crop);
            return Ok(json!({
                "text": format!(
                    "Zoom on [{}, {}, {}, {}] of the last screenshot, shown at {iw}×{ih}. Coordinates for actions still refer to the full screenshot.",
                    n[0], n[1], n[2], n[3]
                ),
                "image": img,
            }));
        }

        let (img, iw, ih) = fit(full);
        let shot = Shot { monitor: idx, x, y, w, h, img_w: iw, img_h: ih };
        self.shot = Some(shot);
        let cursor = self.cursor().and_then(|(cx, cy)| shot.to_image(cx, cy));
        let focused = focused_window();
        let mut text = format!("Display {} of {count}, screenshot {iw}×{ih}.", idx + 1);
        if let Some((cx, cy)) = cursor {
            text.push_str(&format!(" Mouse at ({cx}, {cy})."));
        }
        if let Some(f) = focused {
            text.push_str(&format!(" Active window: {f}."));
        }
        text.push_str(" Use pixel coordinates from this screenshot for actions.");
        Ok(json!({ "text": text, "image": img }))
    }

    // ── Acting ─────────────────────────────────────────────────────────

    fn act(&mut self, args: &Value) -> OpResult {
        let actions = actions_of(args).map_err(|e| {
            let raw = args.to_string();
            crate::core::log(format!("act: couldn't read the steps ({e}): {}", raw.chars().take(600).collect::<String>()));
            format!("FAILED: nothing was done. {e}")
        })?;
        let actions = &actions;
        if actions.is_empty() {
            return Err("no actions given".into());
        }
        if actions.len() > MAX_ACTIONS {
            return Err(format!("at most {MAX_ACTIONS} actions per call"));
        }
        let mut done: Vec<String> = Vec::new();
        let mut last_set: Option<(i32, i32)> = None;
        let mut stopped: Option<String> = None;

        for (i, a) in actions.iter().enumerate() {
            if crate::core::halted() {
                stopped = Some(format!("Stopped before action {}: {}", i + 1, crate::core::STOPPED));
                break;
            }
            // The user moved the mouse since our last move: they're taking over.
            if let Some((lx, ly)) = last_set {
                if let Some((cx, cy)) = self.cursor() {
                    if (cx - lx).abs() > TAKEOVER_PX || (cy - ly).abs() > TAKEOVER_PX {
                        stopped = Some(format!(
                            "Stopped before action {}: you moved the mouse, so Optimus handed control back.",
                            i + 1
                        ));
                        break;
                    }
                }
            }
            if i > 0 {
                std::thread::sleep(Duration::from_millis(if crate::motion::pace() == crate::motion::Pace::Natural { 120 } else { 30 }));
            }
            match self.one(a, &mut last_set) {
                Ok(d) => done.push(d),
                Err(e) => {
                    stopped = Some(format!("Action {} failed: {e}", i + 1));
                    break;
                }
            }
        }
        crate::overlay::done();
        // Let the screen settle, then show what happened (unless asked not to).
        let mut out = json!({});
        // "Sent", not "done": an input reaching the screen doesn't mean it had the intended effect.
        let mut text = if done.is_empty() { "Nothing was sent.".to_string() } else { format!("Sent: {}.", done.join("; ")) };
        if let Some(s) = &stopped {
            text = format!("FAILED: {s} {text}");
        }
        text.push_str(" This only means the input was sent: check the screenshot below to see whether it actually worked before saying so.");
        if args.get("screenshot").and_then(Value::as_bool) != Some(false) {
            std::thread::sleep(Duration::from_millis(args.get("settle_ms").and_then(Value::as_u64).unwrap_or(500).min(5000)));
            match self.look(&json!({})) {
                Ok(v) => {
                    text.push_str("\nScreen now: ");
                    text.push_str(v["text"].as_str().unwrap_or(""));
                    out["image"] = v["image"].clone();
                }
                Err(e) => text.push_str(&format!("\n(No screenshot: {e})")),
            }
        }
        out["text"] = json!(text);
        if stopped.is_some() {
            out["stopped"] = json!(true);
        }
        Ok(out)
    }

    fn point(&self, a: &Value, xk: &str, yk: &str) -> Result<Option<(i32, i32)>, String> {
        match (a.get(xk).and_then(Value::as_f64), a.get(yk).and_then(Value::as_f64)) {
            (Some(x), Some(y)) => {
                let shot = self.shot.ok_or("take a screenshot (look) first, so coordinates have a frame")?;
                shot.to_screen(x, y).map(Some)
            }
            (None, None) => Ok(None),
            _ => Err(format!("{xk} and {yk} go together")),
        }
    }

    fn one(&mut self, a: &Value, last_set: &mut Option<(i32, i32)>) -> Result<String, String> {
        let kind = a.get("type").and_then(Value::as_str).ok_or("each action needs a type")?;
        let at = self.point(a, "x", "y")?;
        let label = |what: &str| match (a.get("x"), a.get("y")) {
            (Some(x), Some(y)) => format!("{what} at ({x}, {y})"),
            _ => what.to_string(),
        };
        let e = self.enigo()?;
        // The pointer glides there like a hand would (motion.rs), never jumps.
        let move_to = |e: &mut Enigo, p: (i32, i32), last: &mut Option<(i32, i32)>| -> Result<(), String> { crate::motion::glide(e, p, last) };
        match kind {
            "click" | "double_click" | "triple_click" | "right_click" | "middle_click" => {
                if let Some(p) = at {
                    move_to(e, p, last_set)?;
                }
                let button = match kind {
                    "right_click" => Button::Right,
                    "middle_click" => Button::Middle,
                    _ => Button::Left,
                };
                let times = match kind {
                    "double_click" => 2,
                    "triple_click" => 3,
                    _ => 1,
                };
                let mods = parse_mods(a.get("modifiers").and_then(Value::as_str).unwrap_or(""))?;
                for m in &mods {
                    e.key(*m, Direction::Press).map_err(err)?;
                }
                for n in 0..times {
                    if n > 0 {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                    e.button(button, Direction::Click).map_err(err)?;
                }
                for m in mods.iter().rev() {
                    e.key(*m, Direction::Release).map_err(err)?;
                }
                Ok(label(&kind.replace('_', " ")))
            }
            "move" => {
                move_to(e, at.ok_or("move needs x and y")?, last_set)?;
                Ok(label("moved the mouse"))
            }
            "mouse_down" | "mouse_up" => {
                if let Some(p) = at {
                    move_to(e, p, last_set)?;
                }
                let d = if kind == "mouse_down" { Direction::Press } else { Direction::Release };
                e.button(Button::Left, d).map_err(err)?;
                Ok(label(&kind.replace('_', " ")))
            }
            "drag" => {
                let from = at.ok_or("drag needs x and y (start)")?;
                let to = self.point(a, "to_x", "to_y")?.ok_or("drag needs to_x and to_y (end)")?;
                let e = self.enigo()?;
                move_to(e, from, last_set)?;
                e.button(Button::Left, Direction::Press).map_err(err)?;
                std::thread::sleep(Duration::from_millis(60));
                let moved = crate::motion::glide(e, to, last_set);
                e.button(Button::Left, Direction::Release).map_err(err)?;
                moved?;
                Ok(format!("dragged to ({}, {})", a["to_x"], a["to_y"]))
            }
            "type" => {
                let text = a.get("text").and_then(Value::as_str).ok_or("type needs text")?;
                if text.chars().count() > MAX_TYPE_CHARS {
                    return Err(format!("type at most {MAX_TYPE_CHARS} characters per action; type the rest in the next act call"));
                }
                if let Some(p) = at {
                    move_to(e, p, last_set)?;
                    e.button(Button::Left, Direction::Click).map_err(err)?;
                    std::thread::sleep(Duration::from_millis(200)); // let the field take focus
                }
                let n = crate::motion::type_text(e, text, last_set)?;
                Ok(format!("typed {n} characters"))
            }
            "paste" => {
                // Rich web editors (X, Gmail, LinkedIn, Docs) take pasted text more reliably than typed keys.
                let text = a.get("text").and_then(Value::as_str).ok_or("paste needs text")?;
                if let Some(p) = at {
                    move_to(e, p, last_set)?;
                    e.button(Button::Left, Direction::Click).map_err(err)?;
                    std::thread::sleep(Duration::from_millis(200));
                }
                let previous = clipboard_get();
                clipboard_set(text)?;
                std::thread::sleep(Duration::from_millis(80));
                let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
                e.key(modifier, Direction::Press).map_err(err)?;
                e.key(Key::Unicode('v'), Direction::Click).map_err(err)?;
                e.key(modifier, Direction::Release).map_err(err)?;
                std::thread::sleep(Duration::from_millis(250));
                if let Some(prev) = previous {
                    let _ = clipboard_set(&prev);
                }
                Ok(format!("pasted {} characters", text.chars().count()))
            }
            "draw" => {
                // A freehand stroke: the button stays down through every point.
                let pts = a.get("points").and_then(points_of).ok_or("draw needs points: [[x, y], …] in screenshot pixels")?;
                if pts.len() < 2 {
                    return Err("draw needs at least two points".into());
                }
                if pts.len() > MAX_DRAW_POINTS {
                    return Err(format!("at most {MAX_DRAW_POINTS} points per stroke"));
                }
                let shot = self.shot.ok_or("take a screenshot (look) first, so coordinates have a frame")?;
                let screen: Vec<(i32, i32)> = pts.iter().map(|(x, y)| shot.to_screen(*x, *y)).collect::<Result<_, _>>()?;
                let e = self.enigo()?;
                move_to(e, screen[0], last_set)?;
                e.button(Button::Left, Direction::Press).map_err(err)?;
                std::thread::sleep(Duration::from_millis(30));
                for w in screen.windows(2) {
                    let (a0, b0) = (w[0], w[1]);
                    let steps = (((b0.0 - a0.0).abs().max((b0.1 - a0.1).abs())) / 6).clamp(1, 20);
                    for s in 1..=steps {
                        let t = s as f64 / steps as f64;
                        let p = (a0.0 + ((b0.0 - a0.0) as f64 * t).round() as i32, a0.1 + ((b0.1 - a0.1) as f64 * t).round() as i32);
                        e.move_mouse(p.0, p.1, Coordinate::Abs).map_err(err)?;
                        std::thread::sleep(Duration::from_millis(4));
                    }
                }
                *last_set = screen.last().copied();
                e.button(Button::Left, Direction::Release).map_err(err)?;
                Ok(format!("drew a stroke through {} points", pts.len()))
            }
            "key" => {
                let combo = a.get("keys").and_then(Value::as_str).ok_or("key needs keys, e.g. \"cmd+t\" or \"enter\"")?;
                let repeat = a.get("repeat").and_then(Value::as_u64).unwrap_or(1).clamp(1, 50);
                let (mods, main) = parse_combo(combo)?;
                for _ in 0..repeat {
                    for m in &mods {
                        e.key(*m, Direction::Press).map_err(err)?;
                    }
                    e.key(main, Direction::Click).map_err(err)?;
                    for m in mods.iter().rev() {
                        e.key(*m, Direction::Release).map_err(err)?;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(if repeat > 1 { format!("pressed {combo} ×{repeat}") } else { format!("pressed {combo}") })
            }
            "scroll" => {
                if let Some(p) = at {
                    move_to(e, p, last_set)?;
                }
                let dir = a.get("direction").and_then(Value::as_str).unwrap_or("down");
                let amount = a.get("amount").and_then(Value::as_i64).unwrap_or(3).clamp(1, 30) as i32;
                crate::motion::smooth_scroll(e, dir, amount)?;
                Ok(label(&format!("scrolled {dir} {amount}")))
            }
            "wait" => {
                let s = a.get("seconds").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.0, 10.0);
                let until = Instant::now() + Duration::from_secs_f64(s);
                while Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(format!("waited {s}s"))
            }
            other => Err(format!("unknown action type {other}")),
        }
    }

    // ── Permissions ────────────────────────────────────────────────────

    fn permissions(&mut self, args: &Value) -> OpResult {
        let request = args.get("request").and_then(Value::as_bool).unwrap_or(false);
        #[cfg(target_os = "macos")]
        {
            let _ = &self.enigo;
            Ok(crate::mac::permission_report(request))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = request;
            Ok(other_os_report())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn other_os_report() -> Value {
    if cfg!(windows) {
        return json!({
            "ready": true,
            "text": "Windows: Optimus can see the screen and use the mouse and keyboard. Windows running as administrator (Task Manager, installers) can't be controlled unless Optimus runs in admin mode.",
        });
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session == "wayland" || std::env::var("WAYLAND_DISPLAY").is_ok() {
        return json!({
            "ready": false,
            "text": "Linux (Wayland): screenshots go through the desktop's screen-sharing prompt, and mouse/keyboard control only reaches X11 (XWayland) apps for now. An X11 session gives Optimus full control.",
        });
    }
    json!({ "ready": true, "text": "Linux (X11): Optimus can see the screen and use the mouse and keyboard." })
}

fn permission_hint() -> &'static str {
    if cfg!(target_os = "macos") { " (allow Optimus in System Settings → Privacy & Security → Accessibility)" } else { "" }
}

fn capture_error(e: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("can't take a screenshot: {e} (allow Optimus in System Settings → Privacy & Security → Screen Recording, then try again)")
    } else {
        format!("can't take a screenshot: {e}")
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Shrink to the model's box and encode as JPEG.
fn fit(img: RgbaImage) -> (Value, u32, u32) {
    let (w, h) = (img.width().max(1), img.height().max(1));
    let scale = (MAX_W as f64 / w as f64).min(MAX_H as f64 / h as f64).min(1.0);
    let (nw, nh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    let rgb = DynamicImage::ImageRgba8(img).resize_exact(nw, nh, FilterType::Triangle).to_rgb8();
    let mut buf = Vec::new();
    let _ = JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY).encode_image(&DynamicImage::ImageRgb8(rgb));
    (
        json!({ "data": base64::engine::general_purpose::STANDARD.encode(&buf), "mimeType": "image/jpeg" }),
        nw,
        nh,
    )
}

fn focused_window() -> Option<String> {
    let w = Window::all().ok()?.into_iter().find(|w| w.is_focused().unwrap_or(false))?;
    let app = w.app_name().unwrap_or_default();
    let title = w.title().unwrap_or_default();
    Some(if title.is_empty() || title == app { app } else { format!("{app} — {title}") })
}

fn windows() -> OpResult {
    let mut list = Window::all().map_err(|e| capture_error(&e.to_string()))?;
    list.sort_by_key(|w| -w.z().unwrap_or(0));
    let lines: Vec<String> = list
        .iter()
        .filter(|w| !w.is_minimized().unwrap_or(false) && w.width().unwrap_or(0) > 40 && w.height().unwrap_or(0) > 40)
        .filter_map(|w| {
            let app = w.app_name().ok()?;
            if app.is_empty() {
                return None;
            }
            let title = w.title().unwrap_or_default();
            let focus = if w.is_focused().unwrap_or(false) { " (active)" } else { "" };
            Some(if title.is_empty() { format!("- {app}{focus}") } else { format!("- {app} — {title}{focus}") })
        })
        .take(30)
        .collect();
    Ok(json!({ "text": if lines.is_empty() { "No windows are open.".to_string() } else { format!("Open windows, front first:\n{}", lines.join("\n")) } }))
}

/// Open an app by name, a URL, or a file/folder.
fn open_target(args: &Value) -> OpResult {
    let target = args.get("target").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).ok_or("open needs a target: an app name, a URL or a path")?;
    let is_url = target.contains("://") || target.starts_with("mailto:");
    let is_path = std::path::Path::new(target).exists();
    let status = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        if !is_url && !is_path {
            // "Chrome" is "Google Chrome", "Word" is "Microsoft Word": match installed apps by name.
            match find_mac_app(target) {
                Ok(path) => {
                    c.arg(path);
                }
                Err(e) => return Err(e),
            }
        } else {
            c.arg(target);
        }
        c.status()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", "", target]).status()
    } else if is_url || is_path {
        std::process::Command::new("xdg-open").arg(target).status()
    } else {
        std::process::Command::new("gtk-launch")
            .arg(target)
            .status()
            .and_then(|s| if s.success() { Ok(s) } else { std::process::Command::new(target).spawn().map(|_| s) })
    };
    match status {
        Ok(s) if s.success() => {
            std::thread::sleep(Duration::from_millis(800));
            Ok(json!({ "text": format!("Opened {target}. Take a screenshot (look) to see it.") }))
        }
        Ok(_) => Err(format!("couldn't open {target} (no app, URL or file by that name)")),
        Err(e) => Err(format!("couldn't open {target}: {e}")),
    }
}

/// Installed macOS apps whose name matches `name` best: exact, then
/// containing it (shortest first), e.g. "chrome" → Google Chrome.app.
fn find_mac_app(name: &str) -> Result<String, String> {
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = norm(name.trim_end_matches(".app"));
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        "/Applications".to_string(),
        "/Applications/Utilities".to_string(),
        "/System/Applications".to_string(),
        "/System/Applications/Utilities".to_string(),
        format!("{home}/Applications"),
        "/System/Library/CoreServices/Applications".to_string(),
    ];
    let mut apps: Vec<(String, String)> = Vec::new(); // (display name, path)
    for d in &dirs {
        let Ok(entries) = std::fs::read_dir(d) else { continue };
        for e in entries.flatten() {
            let file = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = file.strip_suffix(".app") {
                apps.push((stem.to_string(), e.path().to_string_lossy().to_string()));
            }
        }
    }
    if let Some((_, p)) = apps.iter().find(|(n, _)| norm(n) == want) {
        return Ok(p.clone());
    }
    let mut close: Vec<&(String, String)> = apps.iter().filter(|(n, _)| !want.is_empty() && norm(n).contains(&want)).collect();
    close.sort_by_key(|(n, _)| n.len());
    if let Some((_, p)) = close.first() {
        return Ok(p.clone());
    }
    let mut names: Vec<&str> = apps.iter().map(|(n, _)| n.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    Err(format!(
        "{name} isn't installed. Installed apps include: {}. For drawing, Freeform or a web canvas (e.g. open https://excalidraw.com) works.",
        names.iter().take(60).copied().collect::<Vec<_>>().join(", ")
    ))
}

/// The action list, however the model sent it: a list; that list as a JSON
/// string (even twice-encoded, or with single quotes); one action; an object
/// of numbered actions; or one action's fields at the top level. Also under
/// "steps" or "action".
pub fn actions_of(args: &Value) -> Result<Vec<Value>, String> {
    const HOW: &str = "actions must be a list of steps, e.g. [{\"type\": \"click\", \"x\": 100, \"y\": 200}]";
    let raw = match args.get("actions").or_else(|| args.get("steps")).or_else(|| args.get("action")) {
        Some(v) => decode(v.clone()).ok_or(HOW)?,
        None if args.get("type").is_some() => args.clone(),
        None => return Err(HOW.into()),
    };
    let list = match raw {
        Value::Array(a) => a,
        Value::Object(ref o) if o.contains_key("type") => vec![raw],
        // {"0": {...}, "1": {...}} or {"actions": [...]} one level down.
        Value::Object(o) => {
            if let Some(inner) = o.get("actions").cloned().and_then(decode) {
                return actions_of(&serde_json::json!({ "actions": inner }));
            }
            let mut items: Vec<(usize, Value)> = o.into_iter().filter_map(|(k, v)| Some((k.parse::<usize>().ok()?, v))).collect();
            if items.is_empty() {
                return Err(HOW.into());
            }
            items.sort_by_key(|(k, _)| *k);
            items.into_iter().map(|(_, v)| v).collect()
        }
        _ => return Err(HOW.into()),
    };
    let list: Vec<Value> = list.into_iter().filter_map(decode).collect();
    if list.iter().any(|a| !a.is_object()) {
        return Err(HOW.into());
    }
    // Numbers sent as strings ("x": "120") are fine too.
    Ok(list
        .into_iter()
        .map(|mut a| {
            if let Some(o) = a.as_object_mut() {
                for k in ["x", "y", "to_x", "to_y", "amount", "seconds", "repeat"] {
                    if let Some(n) = o.get(k).and_then(Value::as_str).and_then(|s| s.trim().parse::<f64>().ok()) {
                        o.insert(k.into(), json!(n));
                    }
                }
                if let Some(p) = o.get("points").and_then(Value::as_str).and_then(|s| serde_json::from_str::<Value>(s).ok()) {
                    o.insert("points".into(), p);
                }
            }
            a
        })
        .collect())
}

/// A value that may be JSON text (possibly encoded more than once, or with
/// single quotes): decoded until it's an array or object.
fn decode(v: Value) -> Option<Value> {
    let mut v = v;
    for _ in 0..4 {
        let Value::String(s) = &v else { return Some(v) };
        let t = s.trim();
        let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t).trim_end_matches("```").trim();
        v = serde_json::from_str::<Value>(t)
            .or_else(|_| serde_json::from_str::<Value>(&t.replace('\'', "\"")))
            .ok()?;
    }
    (!v.is_string()).then_some(v)
}

/// [[x, y], …] or [{"x": …, "y": …}, …]
fn points_of(v: &Value) -> Option<Vec<(f64, f64)>> {
    v.as_array()?
        .iter()
        .map(|p| match p {
            Value::Array(xy) if xy.len() >= 2 => Some((xy[0].as_f64()?, xy[1].as_f64()?)),
            Value::Object(o) => Some((o.get("x")?.as_f64()?, o.get("y")?.as_f64()?)),
            _ => None,
        })
        .collect()
}

fn clipboard_get() -> Option<String> {
    let out = if cfg!(target_os = "macos") {
        std::process::Command::new("pbpaste").output().ok()?
    } else if cfg!(windows) {
        std::process::Command::new("powershell").args(["-NoProfile", "-Command", "Get-Clipboard -Raw"]).output().ok()?
    } else {
        std::process::Command::new("xclip").args(["-selection", "clipboard", "-o"]).output().ok()?
    };
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn clipboard_set(text: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("pbcopy")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-Command", "$input | Set-Clipboard"]);
        c
    } else if std::env::var("WAYLAND_DISPLAY").is_ok() {
        std::process::Command::new("wl-copy")
    } else {
        let mut c = std::process::Command::new("xclip");
        c.args(["-selection", "clipboard"]);
        c
    };
    let mut child = cmd.stdin(std::process::Stdio::piped()).spawn().map_err(|e| format!("can't reach the clipboard: {e}"))?;
    child.stdin.take().ok_or("clipboard")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("couldn't set the clipboard".into()) }
}

// ── Keys ──────────────────────────────────────────────────────────────

fn key_named(name: &str) -> Result<Key, String> {
    let n = name.trim().to_ascii_lowercase();
    let k = match n.as_str() {
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Key::Meta,
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" | "option" | "opt" => Key::Alt,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" | "spacebar" => Key::Space,
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" => Key::PageUp,
        "pagedown" | "page_down" => Key::PageDown,
        "capslock" => Key::CapsLock,
        "plus" => Key::Unicode('+'),
        "minus" => Key::Unicode('-'),
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ => {
            let mut chars = name.trim().chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c.to_ascii_lowercase()),
                _ => return Err(format!("unknown key \"{name}\"")),
            }
        }
    };
    Ok(k)
}

fn is_modifier(k: Key) -> bool {
    matches!(k, Key::Meta | Key::Control | Key::Shift | Key::Alt)
}

/// "cmd+shift+t" → ([Meta, Shift], t)
fn parse_combo(combo: &str) -> Result<(Vec<Key>, Key), String> {
    let parts: Vec<&str> = combo.split('+').filter(|p| !p.trim().is_empty()).collect();
    // A literal "+" ("cmd++") leaves an empty last part.
    let parts = if combo.trim_end().ends_with("++") || combo.trim() == "+" { [parts, vec!["plus"]].concat() } else { parts };
    let (last, mods) = parts.split_last().ok_or("no key given")?;
    let mods = mods.iter().map(|m| key_named(m)).collect::<Result<Vec<_>, _>>()?;
    if let Some(m) = mods.iter().find(|m| !is_modifier(**m)) {
        return Err(format!("{m:?} isn't a modifier; send separate key actions for a sequence"));
    }
    Ok((mods, key_named(last)?))
}

fn parse_mods(s: &str) -> Result<Vec<Key>, String> {
    s.split('+').map(str::trim).filter(|p| !p.is_empty()).map(key_named).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos() {
        let (m, k) = parse_combo("cmd+shift+t").unwrap();
        assert_eq!(m, vec![Key::Meta, Key::Shift]);
        assert_eq!(k, Key::Unicode('t'));
        assert_eq!(parse_combo("Enter").unwrap(), (vec![], Key::Return));
        assert_eq!(parse_combo("ctrl++").unwrap(), (vec![Key::Control], Key::Unicode('+')));
        assert!(parse_combo("a+b").is_err());
        assert!(parse_combo("cmd+nope").is_err());
    }

    #[test]
    fn mapping_round_trips() {
        // A 2560×1600 Retina display reported as 1440×900 points, shown at 1280×800.
        let s = Shot { monitor: 0, x: 0, y: 0, w: 1440, h: 900, img_w: 1280, img_h: 800 };
        assert_eq!(s.to_screen(640.0, 400.0).unwrap(), (720, 450));
        assert_eq!(s.to_image(720, 450), Some((640, 400)));
        assert!(s.to_screen(1300.0, 10.0).is_err());
        // A second display to the left.
        let s = Shot { monitor: 1, x: -1920, y: 0, w: 1920, h: 1080, img_w: 1280, img_h: 720 };
        assert_eq!(s.to_screen(0.0, 0.0).unwrap(), (-1920, 0));
        assert_eq!(s.to_screen(1280.0, 720.0).unwrap(), (0, 1080));
    }

    #[test]
    fn fit_keeps_aspect() {
        let (_, w, h) = fit(RgbaImage::new(2880, 1800));
        assert_eq!((w, h), (1280, 800));
        let (_, w, h) = fit(RgbaImage::new(3840, 2160));
        assert_eq!((w, h), (1280, 720));
        let (_, w, h) = fit(RgbaImage::new(800, 600));
        assert_eq!((w, h), (800, 600));
    }
}

#[cfg(test)]
mod action_input_tests {
    use super::*;

    #[test]
    fn actions_in_any_shape() {
        let list = json!({ "actions": [{ "type": "click", "x": 1, "y": 2 }] });
        assert_eq!(actions_of(&list).unwrap().len(), 1);
        // Some models send the list as a JSON string, numbers as strings.
        let stringy = json!({ "actions": "[{\"type\":\"click\",\"x\":\"10\",\"y\":20}]" });
        let a = actions_of(&stringy).unwrap();
        assert_eq!(a[0]["x"], json!(10.0));
        // One action, or its fields at the top level.
        assert_eq!(actions_of(&json!({ "actions": { "type": "key", "keys": "enter" } })).unwrap().len(), 1);
        assert_eq!(actions_of(&json!({ "type": "key", "keys": "enter" })).unwrap().len(), 1);
        assert!(actions_of(&json!({})).is_err());
        assert!(actions_of(&json!({ "actions": "not json" })).is_err());
        // Twice-encoded, single quotes, numbered objects, code fences, other keys.
        let twice = serde_json::to_string(&serde_json::to_string(&json!([{ "type": "click", "x": 1, "y": 2 }])).unwrap()).unwrap();
        assert_eq!(actions_of(&json!({ "actions": serde_json::from_str::<Value>(&twice).unwrap() })).unwrap().len(), 1);
        assert_eq!(actions_of(&json!({ "actions": "[{'type': 'key', 'keys': 'enter'}]" })).unwrap().len(), 1);
        assert_eq!(actions_of(&json!({ "actions": { "1": { "type": "key", "keys": "b" }, "0": { "type": "key", "keys": "a" } } })).unwrap()[0]["keys"], json!("a"));
        assert_eq!(actions_of(&json!({ "actions": "```json\n[{\"type\":\"key\",\"keys\":\"enter\"}]\n```" })).unwrap().len(), 1);
        assert_eq!(actions_of(&json!({ "steps": [{ "type": "key", "keys": "enter" }] })).unwrap().len(), 1);
        assert_eq!(actions_of(&json!({ "actions": ["{\"type\":\"key\",\"keys\":\"enter\"}"] })).unwrap().len(), 1);
    }

    #[test]
    fn draw_points() {
        assert_eq!(points_of(&json!([[1, 2], [3.5, 4]])), Some(vec![(1.0, 2.0), (3.5, 4.0)]));
        assert_eq!(points_of(&json!([{ "x": 1, "y": 2 }])), Some(vec![(1.0, 2.0)]));
        assert_eq!(points_of(&json!([[1]])), None);
    }
}
