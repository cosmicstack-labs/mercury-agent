//! Moving like a person: the pointer glides along a gentle curve with
//! ease-in/ease-out, scrolling arrives in many small steps, and typing goes
//! key by key with a natural, uneven rhythm. Everything checks between steps
//! whether the owner grabbed the mouse, and stops if so.
//!
//! Pace comes from the plugin setting `pace`: "natural" (default) or "fast".

use std::time::Duration;

use enigo::{Axis, Coordinate, Direction, Enigo, Key, Keyboard, Mouse};
use serde_json::Value;

/// The owner moving the mouse this far from where we put it means they took over.
const TAKEOVER_PX: i32 = 12;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pace {
    Natural,
    Fast,
}

pub fn pace() -> Pace {
    match crate::core::settings().get("pace").and_then(Value::as_str) {
        Some("fast") => Pace::Fast,
        _ => Pace::Natural,
    }
}

/// Small, dependency-free randomness for timing jitter and curve shape.
struct Jitter(u64);

impl Jitter {
    fn new() -> Self {
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7) | 1;
        Jitter(seed)
    }
    /// 0.0 ..< 1.0
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn between(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const TOOK_OVER: &str = "you moved the mouse, so Optimus stopped and handed control back";

/// Glide the pointer to `to` (screen coordinates). `last` is where we last put it.
pub fn glide(e: &mut Enigo, to: (i32, i32), last: &mut Option<(i32, i32)>) -> Result<(), String> {
    let from = e.location().unwrap_or(to);
    if let Some((lx, ly)) = *last {
        if (from.0 - lx).abs() > TAKEOVER_PX || (from.1 - ly).abs() > TAKEOVER_PX {
            return Err(TOOK_OVER.into());
        }
    }
    let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
    let dist = (dx * dx + dy * dy).sqrt();
    if dist < 2.0 {
        e.move_mouse(to.0, to.1, Coordinate::Abs).map_err(err)?;
        crate::overlay::follow(to.0, to.1);
        *last = Some(to);
        return Ok(());
    }
    let mut j = Jitter::new();
    let ms = match pace() {
        Pace::Natural => (180.0 + dist * 0.45).clamp(200.0, 750.0) * j.between(0.9, 1.15),
        Pace::Fast => (60.0 + dist * 0.12).clamp(70.0, 220.0),
    };
    // A gentle bow sideways, like a wrist pivoting: a quadratic Bézier curve.
    let bow = dist * j.between(0.04, 0.12) * if j.next() < 0.5 { -1.0 } else { 1.0 };
    let (nx, ny) = (-dy / dist, dx / dist);
    let ctrl = (from.0 as f64 + dx * 0.5 + nx * bow, from.1 as f64 + dy * 0.5 + ny * bow);
    let step_ms = 8.0;
    let steps = ((ms / step_ms) as usize).max(4);
    let mut prev = from;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        // Ease in and out (smootherstep).
        let s = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
        let u = 1.0 - s;
        let x = u * u * from.0 as f64 + 2.0 * u * s * ctrl.0 + s * s * to.0 as f64;
        let y = u * u * from.1 as f64 + 2.0 * u * s * ctrl.1 + s * s * to.1 as f64;
        let p = (x.round() as i32, y.round() as i32);
        if crate::core::halted() {
            *last = None;
            return Err(crate::core::STOPPED.into());
        }
        if p != prev {
            // Something other than us moved it since the last step: the owner took over.
            if let Ok(now) = e.location() {
                if (now.0 - prev.0).abs() > TAKEOVER_PX || (now.1 - prev.1).abs() > TAKEOVER_PX {
                    *last = None;
                    return Err(TOOK_OVER.into());
                }
            }
            e.move_mouse(p.0, p.1, Coordinate::Abs).map_err(err)?;
            if i % 2 == 0 || i == steps {
                crate::overlay::follow(p.0, p.1);
            }
            prev = p;
        }
        std::thread::sleep(Duration::from_millis(step_ms as u64));
    }
    e.move_mouse(to.0, to.1, Coordinate::Abs).map_err(err)?;
    crate::overlay::follow(to.0, to.1);
    *last = Some(to);
    // A beat before acting, as a hand settles.
    std::thread::sleep(Duration::from_millis(if pace() == Pace::Natural { j.between(60.0, 140.0) as u64 } else { 20 }));
    Ok(())
}

/// Type `text` key by key. Returns how many characters were typed.
pub fn type_text(e: &mut Enigo, text: &str, last: &Option<(i32, i32)>) -> Result<usize, String> {
    let mut j = Jitter::new();
    let fast = pace() == Pace::Fast;
    let mut n = 0usize;
    for c in text.chars() {
        if crate::core::halted() {
            return Err(format!("typed {n} characters, then: {}", crate::core::STOPPED));
        }
        if n % 12 == 0 {
            if let (Some((lx, ly)), Ok(now)) = (*last, e.location()) {
                if (now.0 - lx).abs() > TAKEOVER_PX || (now.1 - ly).abs() > TAKEOVER_PX {
                    return Err(format!("typed {n} characters, then {TOOK_OVER}"));
                }
            }
        }
        match c {
            '\n' => e.key(Key::Return, Direction::Click).map_err(err)?,
            '\t' => e.key(Key::Tab, Direction::Click).map_err(err)?,
            '\r' => {}
            _ => e.text(&c.to_string()).map_err(err)?,
        }
        n += 1;
        let ms = if fast {
            j.between(4.0, 12.0)
        } else {
            let mut d = j.between(28.0, 85.0);
            if c == ' ' {
                d += j.between(10.0, 60.0);
            }
            if matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '\n') {
                d += j.between(90.0, 260.0);
            }
            // Now and then a short thinking pause.
            if j.next() < 0.015 {
                d += j.between(200.0, 500.0);
            }
            d
        };
        std::thread::sleep(Duration::from_millis(ms as u64));
    }
    Ok(n)
}

/// Scroll `amount` notches in `dir`, smoothly: many small steps instead of jumps.
pub fn smooth_scroll(e: &mut Enigo, dir: &str, amount: i32) -> Result<(), String> {
    let (sign, vertical) = match dir {
        "down" => (1, true),
        "up" => (-1, true),
        "right" => (1, false),
        "left" => (-1, false),
        other => return Err(format!("scroll direction is up, down, left or right, not {other}")),
    };
    let fast = pace() == Pace::Fast;
    platform_scroll(e, sign, vertical, amount, fast)
}

#[cfg(target_os = "macos")]
fn platform_scroll(_e: &mut Enigo, sign: i32, vertical: bool, amount: i32, fast: bool) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventTapLocation, ScrollEventUnit};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    // Pixel scrolling with an ease-out, like a trackpad flick: ~70 px per notch.
    let total = (amount * 70) as f64;
    let steps = if fast { 10 } else { 28 };
    let weights: Vec<f64> = (0..steps).map(|i| 1.0 - i as f64 / steps as f64).collect();
    let sum: f64 = weights.iter().sum();
    let mut sent = 0i32;
    for (i, w) in weights.iter().enumerate() {
        let target = (total * weights[..=i].iter().sum::<f64>() / sum).round() as i32;
        let px = target - sent;
        sent = target;
        if px == 0 {
            continue;
        }
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "can't scroll".to_string())?;
        // CoreGraphics: positive scrolls up/left; ours: positive is down/right.
        let delta = -sign * px;
        let ev = if vertical {
            CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, delta, 0, 0)
        } else {
            CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, 0, delta, 0)
        }
        .map_err(|_| "can't scroll".to_string())?;
        ev.post(CGEventTapLocation::HID);
        let _ = w;
        std::thread::sleep(Duration::from_millis(if fast { 8 } else { 14 }));
    }
    Ok(())
}

#[cfg(windows)]
fn platform_scroll(_e: &mut Enigo, sign: i32, vertical: bool, amount: i32, fast: bool) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput};
    // Windows wheel units are 120 per notch; modern apps scroll smoothly on smaller deltas.
    let per_step = 20i32;
    let steps = (amount * 120 / per_step).max(1);
    for _ in 0..steps {
        // Windows: positive wheel scrolls up; positive h-wheel scrolls right.
        let delta = if vertical { -sign * per_step } else { sign * per_step };
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: delta as _,
                    dwFlags: if vertical { MOUSEEVENTF_WHEEL } else { MOUSEEVENTF_HWHEEL },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
        std::thread::sleep(Duration::from_millis(if fast { 4 } else { 12 }));
    }
    Ok(())
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn platform_scroll(e: &mut Enigo, sign: i32, vertical: bool, amount: i32, fast: bool) -> Result<(), String> {
    // X11 wheel clicks are whole notches: space them out so it reads as scrolling, not jumping.
    for _ in 0..amount {
        e.scroll(sign, if vertical { Axis::Vertical } else { Axis::Horizontal }).map_err(err)?;
        std::thread::sleep(Duration::from_millis(if fast { 15 } else { 45 }));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
#[allow(dead_code)]
fn _axis_used(_: Axis) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_stays_in_range() {
        let mut j = Jitter::new();
        for _ in 0..1000 {
            let v = j.between(2.0, 5.0);
            assert!((2.0..5.0).contains(&v));
        }
    }
}
